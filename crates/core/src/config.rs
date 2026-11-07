use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[derive(Clone, Deserialize, Serialize)]
pub struct Config {
    pub server: Server,
    pub dashboard: Dashboard,
    pub storage: Storage,
    pub capture: Capture,
    pub source: Source,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Server {
    pub host: String,
    pub port: u16,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Dashboard {
    pub timezone: String,
    #[serde(default = "default_assets")]
    pub assets_path: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Storage {
    pub duckdb_path: String,
    pub archive_path: String,
    pub hot_retention_days: i64,
    pub content_retention_days: i64,
    pub zstd_level: i32,
    #[serde(default = "default_memory")]
    pub memory_limit_mb: u32,
    #[serde(default)]
    pub purge_ledger_path: Option<String>,
}
fn default_memory() -> u32 {
    512
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Capture {
    pub default_policy: String,
    pub store_stream_chunks: bool,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Source {
    pub instance_id: String,
    pub display_name: String,
    pub sqlite_path: String,
    pub poll_seconds: u64,
    #[serde(default = "default_true")]
    pub collect_on_serve: bool,
    #[serde(default)]
    pub justrunit_sqlite_path: Option<String>,
}
fn default_assets() -> String {
    "dashboard/dist".into()
}
fn default_true() -> bool {
    true
}
impl Config {
    pub fn storage_identity(&self) -> Result<String> {
        let path = std::fs::canonicalize(&self.storage.duckdb_path)?;
        Ok(crate::privacy::hash(&path.to_string_lossy()))
    }
    pub fn load() -> Result<Self> {
        let path = std::env::var("T3UI_CONFIG").unwrap_or("config/default.toml".into());
        let mut c: Self = toml::from_str(&std::fs::read_to_string(path)?)?;
        // A temporary restore database must still obey this installation's purges.
        if c.storage.purge_ledger_path.is_none() {
            c.storage.purge_ledger_path = std::path::Path::new(&c.storage.duckdb_path)
                .parent()
                .map(|p| p.join("purges.jsonl").to_string_lossy().into());
        }
        if let Ok(p) = std::env::var("T3UI_DB") {
            c.storage.duckdb_path = p;
        }
        if let Ok(p) = std::env::var("T3UI_SOURCE")
            && !p.is_empty()
        {
            c.source.sqlite_path = p;
        }
        if c.source.sqlite_path.is_empty() {
            let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))?;
            c.source.sqlite_path = PathBuf::from(home)
                .join(".t3/userdata/statev2.sqlite")
                .to_string_lossy()
                .into();
        }
        ensure!(
            c.server.host.parse::<std::net::IpAddr>()?.is_loopback(),
            "This version only supports loopback binding; remote API authentication is not implemented"
        );
        ensure!(
            [
                "redacted_only",
                "full_encrypted",
                "metadata_only",
                "disabled"
            ]
            .contains(&c.capture.default_policy.as_str()),
            "Invalid capture policy"
        );
        ensure!(
            c.source.poll_seconds >= 5,
            "poll_seconds must be at least 5"
        );
        ensure!(
            c.storage.content_retention_days >= 0 && c.storage.hot_retention_days > 0,
            "Retention days must be nonnegative (hot > 0)"
        );
        ensure!(
            (64..=8192).contains(&c.storage.memory_limit_mb),
            "storage.memory_limit_mb must be between 64 and 8192"
        );
        Ok(c)
    }
}
