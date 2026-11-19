//! Quota sampling must continue while an import or cold maintenance is busy.
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use t3ui_core::{config::Config, storage::Store};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Disabled,
    Running,
    Ready,
    Retrying,
}

#[derive(Serialize)]
pub struct Status {
    pub state: State,
    /// Completion of a sampling pass, not proof that every provider has a fresh
    /// reading. Provider timestamps and unavailable reasons remain in quota/live.
    pub last_successful_refresh_at: Option<String>,
    pub duration_ms: Option<u128>,
    pub error_category: Option<&'static str>,
    pub poll_seconds: u64,
}

/// One serial sampling loop on connections independent of the import writer.
/// A fresh connection each cycle also discards a failed transaction or panic.
pub fn spawn<F>(
    config: Config,
    connection: Store,
    refresh: F,
) -> (Arc<Mutex<Status>>, Option<tokio::task::JoinHandle<()>>)
where
    F: Fn(&Config, &Store) -> Result<Value> + Send + Sync + 'static,
{
    let poll_seconds = config.source.poll_seconds.clamp(1, 60);
    let enabled = config.source.collect_on_serve;
    let status = Arc::new(Mutex::new(Status {
        state: if enabled {
            State::Running
        } else {
            State::Disabled
        },
        last_successful_refresh_at: None,
        duration_ms: None,
        error_category: None,
        poll_seconds,
    }));
    if !enabled {
        return (status, None);
    }
    let shared_status = status.clone();
    let refresh = Arc::new(refresh);
    let task = tokio::spawn(async move {
        loop {
            shared_status.lock().unwrap().state = State::Running;
            let began = Instant::now();
            let result = match connection.try_clone() {
                Ok(writer) => {
                    let config = config.clone();
                    let refresh = refresh.clone();
                    match tokio::task::spawn_blocking(move || refresh(&config, &writer)).await {
                        Ok(result) => result,
                        Err(error) => Err(error.into()),
                    }
                }
                Err(error) => Err(error),
            };
            {
                let mut current = shared_status.lock().unwrap();
                current.duration_ms = Some(began.elapsed().as_millis());
                match result {
                    Ok(_) => {
                        current.state = State::Ready;
                        current.last_successful_refresh_at = Some(t3ui_core::storage::now());
                        current.error_category = None;
                    }
                    Err(error) => {
                        current.state = State::Retrying;
                        current.error_category = Some("quota_refresh_failed");
                        tracing::warn!(operation = "quota_refresh", error = %error);
                    }
                }
            }
            // No overlap or burst of missed ticks; failures retry within a minute.
            tokio::time::sleep(Duration::from_secs(poll_seconds)).await;
        }
    });
    (status, Some(task))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use t3ui_core::{analytics, quota_alerts, quota_sources, storage::clock};

    fn setup() -> (tempfile::TempDir, Config, Store) {
        let temp = tempfile::tempdir().unwrap();
        let config: Config = serde_json::from_value(json!({
            "server":{"host":"127.0.0.1","port":1},
            "dashboard":{"timezone":"UTC"},
            "storage":{"duckdb_path":temp.path().join("test.duckdb"),"archive_path":temp.path().join("archive"),"purge_ledger_path":temp.path().join("purges.jsonl"),"hot_retention_days":30,"content_retention_days":90,"zstd_level":3},
            "capture":{"default_policy":"redacted_only","store_stream_chunks":false},
            "source":{"instance_id":"neutral","display_name":"Neutral machine","sqlite_path":temp.path().join("absent.sqlite"),"poll_seconds":1,"collect_on_serve":true},
            "quota":{"checks":false,"notifications":false},
            "update":{"check":false}
        })).unwrap();
        let store = Store::open(&config).unwrap();
        (temp, config, store)
    }

    async fn until(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Sampling did not advance while import was blocked");
    }

    #[tokio::test]
    async fn readings_and_both_warnings_advance_during_an_uncommitted_import() {
        let (temp, config, store) = setup();
        let writer = store.try_clone().unwrap();
        writer
            .conn
            .execute_batch("CREATE TABLE busy_import_probe(value INTEGER)")
            .unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let import = std::thread::spawn(move || {
            writer
                .conn
                .execute_batch("BEGIN; INSERT INTO busy_import_probe VALUES(1)")
                .unwrap();
            started_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(25));
            writer.conn.execute_batch("COMMIT").unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let home = temp.path().join("neutral-home");
        let cache = temp.path().join("caches");
        std::fs::create_dir_all(&cache).unwrap();
        let used = Arc::new(AtomicUsize::new(80));
        let amount = used.clone();
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let sink = delivered.clone();
        let reset = (clock() + chrono::Duration::hours(1)).to_rfc3339();
        let (status, task) = spawn(config, store.try_clone().unwrap(), move |_, sample| {
            let now = clock();
            std::fs::write(cache.join("neutral.json"), json!({"driver":"synthetic","instanceId":"neutral","enabled":true,"usageLimits":{"checkedAt":now.to_rfc3339(),"windows":[{"id":"five_hour","usedPercent":amount.load(Ordering::SeqCst),"resetsAt":reset,"windowDurationMins":300}]}}).to_string())?;
            quota_sources::collect_from(sample, &home, Some(&cache))?;
            let readings = analytics::query(sample, "quota/current", &Default::default())?;
            quota_alerts::dispatch(
                sample,
                true,
                now.timestamp_millis(),
                readings["data"].as_array().unwrap(),
                |alert| {
                    sink.lock().unwrap().push(alert.threshold);
                    Ok(())
                },
            )
        });
        until(|| *delivered.lock().unwrap() == [20]).await;
        used.store(95, Ordering::SeqCst);
        until(|| *delivered.lock().unwrap() == [20, 5]).await;
        assert!(
            !import.is_finished(),
            "Import completed before quota advanced"
        );
        let live: Value =
            serde_json::from_str(&store.setting(quota_sources::LIVE).unwrap()).unwrap();
        assert_eq!(
            live["harnesses"][0]["windows"][0]["used_percentage"].as_f64(),
            Some(95.0)
        );
        assert!(status.lock().unwrap().last_successful_refresh_at.is_some());
        release_tx.send(()).unwrap();
        import.join().unwrap();
        task.unwrap().abort();
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM busy_import_probe", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn errors_and_panics_discard_transactions_and_retry() {
        let (_temp, config, store) = setup();
        let attempts = Arc::new(AtomicUsize::new(0));
        let calls = attempts.clone();
        let (status, task) = spawn(config, store.try_clone().unwrap(), move |_, sample| {
            let attempt = calls.fetch_add(1, Ordering::SeqCst);
            sample.conn.execute_batch("BEGIN")?;
            sample.set("quota:test-uncommitted", "pending")?;
            if attempt == 0 {
                anyhow::bail!("Neutral refresh failure")
            }
            assert_ne!(attempt, 1, "Neutral refresh panic");
            sample.conn.execute_batch("ROLLBACK")?;
            Ok(json!({}))
        });
        until(|| status.lock().unwrap().last_successful_refresh_at.is_some()).await;
        task.unwrap().abort();
        assert!(attempts.load(Ordering::SeqCst) >= 3);
        assert!(store.setting("quota:test-uncommitted").is_none());
    }

    #[test]
    fn actual_server_samples_despite_import_failure_and_honors_notifications_off() {
        let (_temp, mut config, store) = setup();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        config.server.port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{}/health/ready", config.server.port);
        let writer = store.try_clone().unwrap();
        // This runtime is dropped before the store/temp directory, including all
        // detached collector tasks. No test worker retains scratch file handles.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let server = tokio::spawn(crate::serve_with_quota_refresh(
                config,
                writer,
                std::path::PathBuf::from("unused-test-config.toml"),
                |config, sample| {
                    sample.set(
                        quota_sources::LIVE,
                        &json!({"read_at":t3ui_core::storage::now(),"harnesses":[]}).to_string(),
                    )?;
                    crate::quota_notify::run(config, sample)
                },
            ));
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                let url = url.clone();
                let response = tokio::task::spawn_blocking(move || -> Result<Value> {
                    Ok(ureq::get(&url).call()?.body_mut().read_json()?)
                })
                .await
                .unwrap();
                if let Ok(health) = response
                    && health["quota_sampler"]["last_successful_refresh_at"].is_string()
                    && health["collector"]["state"] == "retrying"
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "Server quota sampling waited for successful import"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let notification: Value =
                serde_json::from_str(&store.setting("quota:notifications").unwrap()).unwrap();
            assert_eq!(notification["state"], "disabled");
            assert!(store.setting(quota_sources::LIVE).is_some());
            server.abort();
            let _ = server.await;
        });
        drop(runtime);
    }
}
