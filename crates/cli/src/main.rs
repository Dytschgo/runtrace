mod mcp;
use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use t3ui_core::{
    analytics::{self, Filter},
    config::Config,
    importer::{self, Options},
    storage::Store,
};
#[derive(Parser)]
#[command(name = "t3ui", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Init,
    Doctor,
    /// Bring the database up to date, with progress, before the service starts. start.ps1 runs this first.
    Migrate,
    /// One-time import of T3's previous database, for the history from before it moved.
    /// One-time import of token usage that exists only in the agents' session logs, from before T3's current database.
    ImportSessionLogs {
        #[arg(long)]
        cache: String,
        #[arg(long)]
        old_db: String,
        #[arg(long)]
        dry_run: bool,
    },
    /// Reads the quota the coding agents recorded since last time, as the collector does on every sync.
    QuotaCollect,
    ImportLegacy {
        #[arg(long)]
        source: String,
        #[arg(long)]
        dry_run: bool,
    },
    ValidateSource {
        #[arg(long)]
        project: Option<String>,
    },
    Serve,
    Collect,
    Import {
        #[arg(long)]
        all: bool,
        #[arg(long)]
        instance: Option<String>,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        since: Option<String>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        verify: bool,
        #[arg(long)]
        repair: bool,
        #[arg(long, hide = true)]
        thread_limit: Option<usize>,
    },
    Mcp {
        action: String,
    },
    Storage {
        action: String,
        #[arg(long)]
        against: Option<String>,
    },
    Capture {
        action: String,
    },
    Project {
        action: String,
        project_id: String,
        policy: String,
    },
    Purge {
        scope: String,
        id: String,
    },
    Export {
        #[arg(long, default_value = "data/export.json")]
        output: String,
    },
    Archive {
        action: String,
        #[arg(long)]
        path: Option<String>,
    },
    Retention {
        action: String,
    },
    /// Fills an empty database with the synthetic history the browser tests read, placed relative to --now. Not for real use.
    #[command(hide = true)]
    Fixture {
        #[arg(long)]
        now: String,
    },
}
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cli = Cli::parse();
    if let Ok(pinned) = std::env::var("T3UI_NOW") {
        anyhow::ensure!(
            t3ui_core::storage::pinned_now().is_some(),
            "T3UI_NOW must be an RFC 3339 instant, such as 2026-11-08T13:37:00Z, not {pinned:?}"
        );
    }
    let c = Config::load()?;
    if let Command::ValidateSource { ref project } = cli.command {
        println!("{}", importer::validate_source(&c, project.as_deref())?);
        return Ok(());
    }
    if let Command::Capture { ref action } = cli.command {
        anyhow::ensure!(
            ["pause", "resume"].contains(&action.as_str()),
            "Use capture pause or capture resume"
        );
        let path = importer::pause_path(&c);
        if action == "resume" {
            let _ = Store::open(&c);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if action == "pause" {
            std::fs::write(&path, b"paused")?;
        } else if path.exists() {
            std::fs::remove_file(path)?;
        }
        println!("Capture {action}");
        return Ok(());
    }
    if let Command::ImportSessionLogs { ref cache, ref old_db, dry_run: true } = cli.command {
        println!("{}", t3ui_core::session_logs::import(&c, None, cache, old_db)?);
        return Ok(());
    }
    if let Command::ImportLegacy { ref source, dry_run: true } = cli.command {
        println!("{}", t3ui_core::legacy::import_v1(&c, None, source)?);
        return Ok(());
    }
    if matches!(cli.command, Command::Mcp { .. }) {
        return tokio::task::spawn_blocking(move || mcp::serve_remote(&c)).await?;
    }
    let opened = std::time::Instant::now();
    let s = Store::open(&c)?;
    match cli.command {
        Command::Migrate => println!(
            "Database is up to date ({:.1} s)",
            opened.elapsed().as_secs_f64()
        ),
        Command::Init => {
            std::fs::create_dir_all(&c.storage.archive_path)?;
            if c.capture.default_policy == "full_encrypted" {
                t3ui_core::privacy::key(true)?;
            }
            println!("Initialized. Policy: {}", c.capture.default_policy);
        }
        Command::ImportSessionLogs { cache, old_db, .. } => {
            println!("{}", t3ui_core::session_logs::import(&c, Some(&s), &cache, &old_db)?);
        }
        Command::QuotaCollect => println!("{}", t3ui_core::quota_sources::collect(&s)?),
        Command::ImportLegacy { source, .. } => {
            println!("{}", t3ui_core::legacy::import_v1(&c, Some(&s), &source)?);
        }
        Command::Doctor => println!(
            "{}",
            json!({"database":"writable","source_exists":std::path::Path::new(&c.source.sqlite_path).exists(),"transport":"sqlite_readonly","http_auth":"not configured","websocket":"not implemented","quota":"unavailable","keychain":t3ui_core::privacy::key(false).is_ok(),"dashboard_built":std::path::Path::new("dashboard/dist/index.html").exists(),"clock_offset":"unavailable","mcp":"stdio implemented"})
        ),
        Command::Import {
            instance,
            project,
            since,
            dry_run,
            verify,
            repair,
            thread_limit,
            ..
        } => {
            anyhow::ensure!(
                instance.as_ref().is_none_or(|i| i == &c.source.instance_id),
                "Instance not configured; use separate TOML source.instance_id/sqlite_path"
            );
            if verify {
                println!(
                    "{}",
                    analytics::query(&s, "data-quality", &Filter::default())?
                )
            } else {
                if let Some(ref d) = since {
                    Filter {
                        since: Some(d.clone()),
                        ..Default::default()
                    }
                    .validate()?;
                }
                println!(
                    "{}",
                    importer::import(
                        &c,
                        &s,
                        &Options {
                            project,
                            since: if repair { Some(String::new()) } else { since },
                            dry_run,
                            thread_limit
                        }
                    )?
                )
            }
        }
        Command::Collect => {
            let mut delay = c.source.poll_seconds;
            loop {
                match importer::import(&c, &s, &Options::default()) {
                    Ok(report) => {
                        tracing::info!(operation="collect",instance_id=c.source.instance_id,report=%report);
                        delay = c.source.poll_seconds
                    }
                    Err(_) => {
                        tracing::warn!(
                            operation = "collect",
                            error_category = "source_sync_failed",
                            retry_seconds = delay
                        );
                        delay = (delay * 2).min(3600)
                    }
                }
                tokio::select! {_=tokio::signal::ctrl_c()=>break,_=tokio::time::sleep(std::time::Duration::from_secs(delay))=>{}}
            }
        }
        Command::Serve => serve(c, s).await?,
        Command::Mcp { .. } => unreachable!(),
        Command::ValidateSource { .. } => unreachable!(),
        Command::Storage { action, against } => {
            if action == "benchmark" {
                println!("{}", t3ui_core::compression::benchmark(&c, &s)?)
            } else if action == "verify" {
                let path = against.ok_or_else(|| {
                    anyhow::anyhow!("Use storage verify --against <stopped-DuckDB-backup>")
                })?;
                let quoted = path.replace('\'', "''");
                s.conn
                    .execute_batch(&format!("ATTACH '{quoted}' AS prior (READ_ONLY)"))?;
                let different =
                    t3ui_core::storage::verify_original_records(&s.conn, "prior.records")?;
                println!(
                    "{}",
                    json!({"different_original_rows":different,"comparison":"exact original columns and preserved physical order, 128-row sequential batches","unchanged":different==0})
                );
                anyhow::ensure!(different == 0, "Original captured data differs from backup");
            } else {
                anyhow::ensure!(action == "stats", "Use storage stats or storage benchmark");
                println!("{}", s.stats()?)
            }
        }
        Command::Capture { action } => {
            anyhow::ensure!(
                ["pause", "resume"].contains(&action.as_str()),
                "Use pause or resume"
            );
            s.set("paused", if action == "pause" { "true" } else { "false" })?;
            println!("Capture {action}");
        }
        Command::Project {
            action,
            project_id,
            policy,
        } => {
            anyhow::ensure!(
                action == "privacy"
                    && [
                        "full_encrypted",
                        "redacted_only",
                        "metadata_only",
                        "disabled"
                    ]
                    .contains(&policy.as_str()),
                "Use project privacy <id> <policy>"
            );
            s.set(&format!("privacy:{project_id}"), &policy)?;
            println!("Future capture policy updated; purge existing content separately");
        }
        Command::Purge { scope, id } => {
            s.purge(&scope, &id)?;
            println!("Purged with reimport tombstone. Remove old backups separately.");
        }
        Command::Export { output } => {
            std::fs::write(
                &output,
                serde_json::to_vec_pretty(&analytics::query(
                    &s,
                    "search",
                    &Filter {
                        limit: Some(500),
                        ..Default::default()
                    },
                )?)?,
            )?;
            println!("Exported at most 500 redacted records: {output}");
        }
        Command::Archive { action, path } => {
            if action == "restore" {
                println!("{}",t3ui_core::archive::restore(&s,std::path::Path::new(path.as_deref().ok_or_else(||anyhow::anyhow!("Use archive restore --path <snapshot-directory> with an empty target database"))?))?)
            } else {
                println!("{}", t3ui_core::archive::run(&c, &s, &action)?)
            }
        }
        Command::Fixture { now } => {
            println!("{}", t3ui_core::fixture::build(&s, &c.source.instance_id, &now)?)
        }
        Command::Retention { action } => {
            anyhow::ensure!(action == "run", "Use retention run");
            t3ui_core::storage::retain_content(&s.conn, c.storage.content_retention_days)?;
            println!("Expired retained content; metadata kept");
        }
    }
    Ok(())
}
type Shared = Arc<Mutex<Store>>;
async fn serve(c: Config, s: Store) -> Result<()> {
    use axum::{Router, routing::get};
    let addr = format!("{}:{}", c.server.host, c.server.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let status = Arc::new(Mutex::new(
        json!({"state":if c.source.collect_on_serve{"starting"}else{"disabled"}}),
    ));
    let ready_status = status.clone();
    let storage_identity = c.storage_identity()?;
    if c.source.collect_on_serve {
        let writer = s.try_clone()?;
        let collect_config = c.clone();
        tokio::spawn(async move {
            let mut writer = writer;
            let mut delay = collect_config.source.poll_seconds;
            loop {
                let config = collect_config.clone();
                let started = std::time::Instant::now();
                let result = tokio::task::spawn_blocking(move || {
                    let report = importer::import(&config, &writer, &Options::default());
                    if let Err(error) = t3ui_core::quota_sources::collect(&writer) {
                        tracing::warn!(operation = "quota_collect", error = %error);
                    }
                    (writer, report)
                })
                .await;
                match result {
                    Ok((returned, report)) => {
                        writer = returned;
                        match report {
                            Ok(report) => {
                                *status.lock().unwrap() = json!({"state":if report["paused"]==true{"paused"}else if report["partial_sync"]==true{"partial"}else{"synced"},"last_successful_sync_at":if report["paused"]==true{None}else{Some(t3ui_core::storage::now())},"duration_ms":started.elapsed().as_millis(),"report":report});
                                delay = collect_config.source.poll_seconds;
                            }
                            Err(_) => {
                                *status.lock().unwrap() = json!({"state":"retrying","error_category":"source_sync_failed","retry_seconds":delay});
                                delay = (delay * 2).min(3600);
                            }
                        }
                    }
                    Err(_) => {
                        *status.lock().unwrap() =
                            json!({"state":"failed","error_category":"collector_task_failed"});
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
        });
    }
    let app = Router::new()
        .route(
            "/health/live",
            get(|| async { axum::Json(json!({"status":"live"})) }),
        )
        .route(
            "/health/ready",
            get(move || {
                let status = ready_status.clone();
                let identity = storage_identity.clone();
                async move {
                    axum::Json(json!({"ready":true,"pid":std::process::id(),"storage_identity":identity,"collector":status.lock().unwrap().clone()}))
                }
            }),
        )
        .route("/api/v1/{*path}", get(api))
        .with_state(Arc::new(Mutex::new(s)))
        .fallback_service(
            tower_http::services::ServeDir::new(&c.dashboard.assets_path).not_found_service(
                tower_http::services::ServeFile::new(
                    std::path::Path::new(&c.dashboard.assets_path).join("index.html"),
                ),
            ),
        );
    println!("T3 Usage Intelligence http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
async fn api(
    axum::extract::State(s): axum::extract::State<Shared>,
    axum::extract::Path(path): axum::extract::Path<String>,
    query: Result<axum::extract::Query<Filter>, axum::extract::rejection::QueryRejection>,
    headers: axum::http::HeaderMap,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    use axum::http::StatusCode;
    let mut f = match query {
        Ok(axum::extract::Query(f)) => f,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(
                    json!({"error":{"code":"invalid_filters","message":"Unknown filter or invalid parameter value"}}),
                ),
            );
        }
    };
    if let Err(error) = f.validate() {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error":{"code":"invalid_filters","message":error.to_string()}})),
        );
    }
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !(host.starts_with("127.0.0.1:")
        || host.starts_with("localhost:")
        || host.starts_with("[::1]:"))
    {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({"error":{"code":"invalid_host"}})),
        );
    }
    if headers
        .get("origin")
        .and_then(|x| x.to_str().ok())
        .is_some_and(|o| o != format!("http://{host}"))
    {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({"error":{"code":"cross_origin_denied"}})),
        );
    }
    let parts: Vec<_> = path.split('/').collect();
    let name = if parts.len() >= 2
        && ["threads", "projects", "agents", "tool-calls", "model-turns"].contains(&parts[0])
    {
        f.id = Some(parts[1].into());
        f.include_content = Some(true);
        if parts.get(2) == Some(&"timeline") {
            "timeline"
        } else if parts.get(2) == Some(&"tree") {
            "agents"
        } else {
            parts[0]
        }
    } else {
        &path
    };
    let name = name.to_string();
    let result = tokio::task::spawn_blocking(move || {
        // The lock is held only to open a connection of this request's own, so reads run side by side.
        let db = s
            .lock()
            .map_err(|_| anyhow::anyhow!("Database unavailable"))?
            .try_clone()?;
        analytics::query(&db, &name, &f)
    })
    .await;
    match result {
        Ok(Ok(v)) => (StatusCode::OK, axum::Json(v)),
        Ok(Err(error)) => {
            if error.to_string() == "Unknown analytics operation" {
                return (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"error":{"code":"unknown_endpoint"}})),
                );
            }
            let category = importer::error_category(&error);
            tracing::warn!(operation = "api_query", error_category = category);
            let (status, message) = if category == "database_memory_limit" {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Query exceeded the configured database memory budget",
                )
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Analytics query failed; inspect local service logs",
                )
            };
            (
                status,
                axum::Json(
                    json!({"error":{"code":category,"message":message,"retryable":category=="database_memory_limit"}}),
                ),
            )
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({"error":{"code":"query_task_failed"}})),
        ),
    }
}
