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
    #[serde(default)]
    pub update: Update,
}
/// Where new versions come from. Checking only reads the latest release; installing always needs a person to ask for it.
#[derive(Clone, Deserialize, Serialize)]
pub struct Update {
    #[serde(default = "default_true")]
    pub check: bool,
    #[serde(default = "default_repo")]
    pub repo: String,
    #[serde(default = "default_api")]
    pub api_base: String,
}
impl Default for Update {
    fn default() -> Self {
        Self {
            check: true,
            repo: default_repo(),
            api_base: default_api(),
        }
    }
}
fn default_repo() -> String {
    "Dytschgo/runtrace".into()
}
fn default_api() -> String {
    "https://api.github.com".into()
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Server {
    pub host: String,
    pub port: u16,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Dashboard {
    /// Unused by the service; the dashboard keeps its own time zone setting, defaulting to the browser's.
    #[serde(default)]
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
/// Empty means the dashboard built into the program. A folder is used only by a build without one, such as a development build.
fn default_assets() -> String {
    "dashboard/dist".into()
}

/// A setting from the environment under its Runtrace name, or under the older T3UI name an existing install may still set.
pub fn env(name: &str) -> Option<String> {
    std::env::var(format!("RUNTRACE_{name}"))
        .or_else(|_| std::env::var(format!("T3UI_{name}")))
        .ok()
        .filter(|v| !v.is_empty())
}

/// This person's Runtrace folder: RUNTRACE_HOME, else the system's per-user app data folder.
pub fn home_dir() -> Result<PathBuf> {
    if let Some(h) = env("HOME") {
        return Ok(PathBuf::from(h));
    }
    let base = dirs::data_local_dir()
        .ok_or_else(|| anyhow::anyhow!("No per-user data folder found; set RUNTRACE_HOME"))?;
    Ok(base.join(if cfg!(target_os = "linux") {
        "runtrace"
    } else {
        "Runtrace"
    }))
}

/// The settings file in use: RUNTRACE_CONFIG, else a source checkout's config/default.toml, else the one in this person's
/// Runtrace folder, which is written with sensible defaults the first time.
pub fn config_path() -> Result<PathBuf> {
    if let Some(p) = env("CONFIG") {
        return Ok(PathBuf::from(p));
    }
    let checkout = PathBuf::from("config/default.toml");
    if checkout.exists() {
        return Ok(checkout);
    }
    let home = home_dir()?;
    let path = home.join("config.toml");
    if !path.exists() {
        std::fs::create_dir_all(home.join("data"))?;
        std::fs::write(&path, default_config(&home))?;
    }
    Ok(path)
}

/// The settings a new install starts with. Paths are absolute inside the Runtrace folder, so it can be started from anywhere.
pub fn default_config(home: &std::path::Path) -> String {
    let h = home.to_string_lossy().replace('\\', "/");
    format!(
        r#"# Runtrace settings. After a change, run `runtrace stop` and `runtrace start`.
[server]
# Only this computer can reach the dashboard.
host = "127.0.0.1"
port = 4310

[dashboard]
assets_path = ""

[storage]
duckdb_path = "{h}/data/runtrace.duckdb"
archive_path = "{h}/data/archive"
hot_retention_days = 30
content_retention_days = 90
zstd_level = 8
memory_limit_mb = 2048

[capture]
# redacted_only keeps conversation text with secrets removed. metadata_only keeps no text at all.
default_policy = "redacted_only"
store_stream_chunks = false

[source]
instance_id = "local"
display_name = "Local T3"
# Empty finds T3 Code's history in your home folder (.t3/userdata/statev2.sqlite).
sqlite_path = ""
poll_seconds = 60
collect_on_serve = true

[update]
# Look for a new version about once a day. Nothing installs until you choose to update.
check = true
repo = "Dytschgo/runtrace"
"#
    )
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
        Self::load_from(&config_path()?)
    }
    pub fn load_from(path: &std::path::Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Cannot read settings at {}: {e}", path.display()))?;
        let mut c: Self = toml::from_str(&text)
            .map_err(|e| anyhow::anyhow!("Settings at {} are not valid: {e}", path.display()))?;
        // A temporary restore database must still obey this installation's purges.
        if c.storage.purge_ledger_path.is_none() {
            c.storage.purge_ledger_path = std::path::Path::new(&c.storage.duckdb_path)
                .parent()
                .map(|p| p.join("purges.jsonl").to_string_lossy().into());
        }
        if let Some(p) = env("DB") {
            c.storage.duckdb_path = p;
        }
        if let Some(p) = env("SOURCE") {
            c.source.sqlite_path = p;
        }
        if env("NO_UPDATE_CHECK").is_some() {
            c.update.check = false;
        }
        if c.source.sqlite_path.is_empty() {
            let home = dirs::home_dir()
                .ok_or_else(|| anyhow::anyhow!("No home folder found; set source.sqlite_path"))?;
            c.source.sqlite_path = home
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
