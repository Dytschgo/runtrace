use serde_json::json;
use t3ui_core::{
    analytics::{Filter, query},
    config::Config,
    storage::Store,
};

#[test]
fn requested_run_models_and_configured_thread_models_keep_their_own_scope() {
    let tmp = tempfile::tempdir().unwrap();
    let mut c: Config = toml::from_str(include_str!("../../../config/default.toml")).unwrap();
    c.storage.duckdb_path = tmp.path().join("fixture.duckdb").to_string_lossy().into();
    c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
    let s = Store::open(&c).unwrap();
    let at = "2026-11-02T12:00:00Z";
    for (machine, thread, configured, requested, status) in [
        ("local", "t1", "neutral-a", "neutral-a", "failed"),
        ("local", "t2", "neutral-b", "neutral-a", "failed"),
        ("local", "t3", "neutral-b", "neutral-b", "completed"),
        ("remote", "t1", "neutral-c", "neutral-c", "failed"),
    ] {
        for (kind, id, run, data) in [
            (
                "thread",
                thread,
                "",
                json!({"title":"Neutral thread","thread_type":"primary","model":configured}),
            ),
            (
                "run",
                "r",
                "r",
                json!({"requested_model":requested,"status":status}),
            ),
            (
                "model_turn",
                "turn",
                "r",
                json!({"model":requested,"status":"completed","provider":"codex"}),
            ),
        ] {
            // Different threads have distinct source IDs; the remote machine
            // deliberately reuses the first local thread/run/turn identities.
            let source = if kind == "thread" {
                id.to_owned()
            } else {
                format!("{thread}-{id}")
            };
            let run_id = if run.is_empty() {
                String::new()
            } else {
                format!("{thread}-{run}")
            };
            s.put(
                machine, kind, &source, "p", thread, &run_id, at, at, "partial", "fixture", data,
            )
            .unwrap();
        }
    }
    let filter = Filter {
        instance: Some("local".into()),
        status: Some("failed".into()),
        since: Some("2026-11-01T00:00:00Z".into()),
        until: Some("2026-11-08T00:00:00Z".into()),
        ..Default::default()
    };
    let models = query(&s, "models", &filter).unwrap();
    let rows = models["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["model"], "neutral-a");
    assert_eq!(rows[0]["observed_runs"], 2);
    assert_eq!(rows[0]["observed_provider_turns"], 2);
    assert_eq!(rows[0]["observed_threads"], 1);
    let threads = query(&s, "threads", &filter).unwrap();
    let rows = threads["data"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let mut configured: Vec<_> = rows
        .iter()
        .map(|r| r["data"]["model"].as_str().unwrap())
        .collect();
    configured.sort_unstable();
    assert_eq!(configured, ["neutral-a", "neutral-b"]);
}
