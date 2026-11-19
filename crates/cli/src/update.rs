//! New versions come from the project's GitHub releases. A check only reads the latest release. Installing downloads
//! the program for this platform, checks it against the release's SHA256SUMS, backs up the database, swaps the
//! program and starts it again.
use crate::control;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use t3ui_core::config::Config;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The release file for this platform, e.g. runtrace-x86_64-pc-windows-msvc.exe.
pub fn asset_name() -> String {
    format!(
        "runtrace-{}{}",
        env!("RUNTRACE_TARGET"),
        std::env::consts::EXE_SUFFIX
    )
}

/// "v1.2.3" or "1.2.3" as numbers. Anything after a dash (a pre-release) is ignored.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut p = core.split('.').map(|x| x.parse::<u64>().ok());
    Some((
        p.next()??,
        p.next().flatten().unwrap_or(0),
        p.next().flatten().unwrap_or(0),
    ))
}

fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .build()
        .into()
}

/// The latest published release.
pub fn latest(c: &Config) -> Result<Value> {
    let url = format!(
        "{}/repos/{}/releases/latest",
        c.update.api_base.trim_end_matches('/'),
        c.update.repo
    );
    let rel: Value = agent(20)
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", &format!("runtrace/{VERSION}"))
        .call()
        .with_context(|| format!("Could not reach {url}"))?
        .body_mut()
        .read_json()?;
    Ok(rel)
}

/// What the latest release means for this install.
pub fn check(c: &Config) -> Result<Value> {
    let rel = latest(c)?;
    let tag = rel["tag_name"].as_str().unwrap_or_default().to_string();
    let newer =
        matches!((parse_version(&tag), parse_version(VERSION)), (Some(a), Some(b)) if a > b);
    let has_asset = rel["assets"]
        .as_array()
        .is_some_and(|a| a.iter().any(|x| x["name"] == asset_name()));
    Ok(json!({
        "current": VERSION,
        "latest": tag.trim_start_matches('v'),
        "available": newer && has_asset,
        "url": rel["html_url"],
        "notes": rel["body"].as_str().map(|b| b.chars().take(4000).collect::<String>()),
        "published_at": rel["published_at"],
        "checked_at": chrono::Utc::now().to_rfc3339(),
    }))
}

fn download(rel: &Value, name: &str) -> Result<Vec<u8>> {
    let url = rel["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["name"] == name))
        .and_then(|x| x["browser_download_url"].as_str())
        .with_context(|| format!("The release has no {name}"))?;
    let mut body = agent(600)
        .get(url)
        .header("User-Agent", &format!("runtrace/{VERSION}"))
        .call()?
        .into_body();
    Ok(body.with_config().limit(512 * 1024 * 1024).read_to_vec()?)
}

/// Installs the latest release if it is newer. The service is stopped for the swap and started again if it was running.
pub fn apply(c: &Config, config_path: &Path, restart: bool) -> Result<()> {
    let rel = latest(c)?;
    let tag = rel["tag_name"].as_str().unwrap_or_default();
    let (Some(new), Some(cur)) = (parse_version(tag), parse_version(VERSION)) else {
        bail!("Cannot read the release version {tag:?}")
    };
    if new <= cur {
        println!("Runtrace {VERSION} is up to date.");
        return Ok(());
    }
    let name = asset_name();
    println!("Downloading Runtrace {tag} ({name})...");
    let bin = download(&rel, &name)?;
    let sums = String::from_utf8(download(&rel, "SHA256SUMS")?)?;
    let want = sums
        .lines()
        .filter_map(|l| l.split_once(char::is_whitespace))
        .find(|(_, f)| f.trim().trim_start_matches('*') == name)
        .map(|(h, _)| h.to_ascii_lowercase())
        .context("SHA256SUMS does not list this platform's file")?;
    let got = hex::encode(Sha256::digest(&bin));
    if got != want {
        bail!("The download does not match its published checksum, so nothing was changed");
    }
    let was_running = control::stop(c)?;
    if let Err(error) = backup(c, tag) {
        if was_running && let Err(restart_error) = control::start(c, config_path, false) {
            return Err(error.context(format!(
                "Backup failed; the previous service also could not restart: {restart_error}"
            )));
        }
        return Err(
            error.context("Update cancelled before replacement; the previous program is installed")
        );
    }
    let exe = std::env::current_exe()?;
    let staged = exe.with_extension("download");
    std::fs::write(&staged, &bin)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    self_replace::self_replace(&staged).context("Could not replace the program")?;
    let _ = std::fs::remove_file(&staged);
    println!("Updated Runtrace {VERSION} to {tag}.");
    if was_running || restart {
        // The new program starts itself, so the new version's database updates run before it serves.
        let status = Command::new(&exe)
            .arg("start")
            .env("RUNTRACE_CONFIG", config_path)
            .env_remove("T3UI_CONFIG")
            .status()?;
        if !status.success() {
            bail!(
                "The new version did not start. Run `runtrace start` to see why; the database backup is in {}",
                backups_dir(c).display()
            );
        }
    }
    Ok(())
}

fn backups_dir(c: &Config) -> std::path::PathBuf {
    control::run_dir(c).join("backups")
}

fn completed_backup_time(path: &Path) -> Option<std::time::SystemTime> {
    if !path.file_name()?.to_str()?.starts_with("before-update-")
        || path.join("backup.incomplete").exists()
    {
        return None;
    }
    let marker = path.join("backup.complete.json");
    let value: Value = serde_json::from_str(&std::fs::read_to_string(&marker).ok()?).ok()?;
    let database = Path::new(value["database"].as_str()?);
    if value["format"].as_u64() != Some(1)
        || database.parent() != Some(Path::new("database"))
        || database.file_name().is_none()
        || !path.join(database).is_file()
    {
        return None;
    }
    std::fs::metadata(marker).ok()?.modified().ok()
}

/// Copies the database, WAL and registered cold files before an update.
/// Retains its completed predecessor and older copies used by restored data.
fn backup(c: &Config, tag: &str) -> Result<()> {
    backup_at(c, tag, &control::stamp())
}

fn backup_at(c: &Config, tag: &str, stamp: &str) -> Result<()> {
    let db = Path::new(&c.storage.duckdb_path);
    if !db.exists() {
        return Ok(());
    }
    let root = backups_dir(c);
    std::fs::create_dir_all(&root)?;
    let (major, minor, patch) = parse_version(tag).context("Invalid backup target version")?;
    let mut selected = None;
    for attempt in 0..1000 {
        let candidate = root.join(format!(
            "before-update-{VERSION}-to-{major}.{minor}.{patch}-{stamp}-{}-{attempt}",
            std::process::id()
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                selected = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    let dir = selected.context("Could not allocate a unique backup generation")?;
    std::fs::write(dir.join("backup.incomplete"), b"Backup in progress\n")?;
    let database_directory = dir.join("database");
    std::fs::create_dir(&database_directory)?;
    let mut wal = db.as_os_str().to_owned();
    wal.push(".wal");
    for file in [db.to_path_buf(), std::path::PathBuf::from(wal)] {
        if let (true, Some(n)) = (file.exists(), file.file_name()) {
            std::fs::copy(&file, database_directory.join(n))?;
        }
    }
    let copied_database =
        database_directory.join(db.file_name().context("Database has no filename")?);
    let source_paths = t3ui_core::cold::make_backup_self_contained(&copied_database, &dir)
        .context(
            "The update backup could not be made self-contained; the program was not replaced",
        )?;
    let segments = source_paths.len();
    let completed = dir.join("backup.complete.json");
    std::fs::write(
        &completed,
        json!({"format":1,"database":format!("database/{}",db.file_name().unwrap().to_string_lossy()),"version":VERSION,"target":tag,"cold_segments":segments}).to_string(),
    )?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(&completed)?
        .sync_all()?;
    std::fs::remove_file(dir.join("backup.incomplete"))?;
    #[cfg(unix)]
    {
        std::fs::File::open(&dir)?.sync_all()?;
        std::fs::File::open(&root)?.sync_all()?;
        if let Some(parent) = root.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
    }
    println!(
        "Backed up the database and {segments} cold segments to {}",
        dir.display()
    );
    let mut previous: Vec<_> = std::fs::read_dir(&root)?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path == dir {
                return None;
            }
            Some((completed_backup_time(&path)?, path))
        })
        .collect();
    previous.sort_unstable();
    previous.reverse();
    let predecessor = previous.first().map(|(_, path)| path);
    for old in std::fs::read_dir(&root)?.flatten() {
        let p = old.path();
        if p != dir
            && predecessor != Some(&p)
            && completed_backup_time(&p).is_some()
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("before-update-"))
        {
            let Ok(resolved) = std::fs::canonicalize(&p) else {
                continue;
            };
            if source_paths.iter().any(|path| path.starts_with(&resolved)) {
                continue;
            }
            let _ = std::fs::remove_dir_all(p);
        }
    }
    Ok(())
}

/// Starts an update in its own process, so it can stop this service, swap the program and start the new one.
pub fn spawn_apply(
    c: &Config,
    config_path: &Path,
) -> Result<(std::process::Child, std::path::PathBuf)> {
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.args(["update", "--yes", "--restart"])
        .env("RUNTRACE_CONFIG", config_path)
        .env_remove("T3UI_CONFIG");
    let log = control::logs_dir(c).join(format!("update-{}.log", control::stamp()));
    let child = control::spawn_detached(cmd, &log)?;
    Ok((child, log))
}

/// The service's side of updates, as one state.
///
/// ```text
/// disabled                                  ([update] check = false)
/// not_checked --check--> up_to_date <-> available --apply--> applying --updater exits, service still here--> apply_failed
///                                          ^                    | (success stops this service; the new one starts fresh)
///                                          +------apply again---+----------------------------------------------+
/// ```
/// A failed check changes no state; it only records when it failed, so a known release is never forgotten.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateState {
    Disabled,
    NotChecked,
    UpToDate,
    Available,
    Applying,
    ApplyFailed,
}

impl UpdateState {
    pub fn name(self) -> &'static str {
        match self {
            UpdateState::Disabled => "disabled",
            UpdateState::NotChecked => "not_checked",
            UpdateState::UpToDate => "up_to_date",
            UpdateState::Available => "available",
            UpdateState::Applying => "applying",
            UpdateState::ApplyFailed => "apply_failed",
        }
    }
}

pub struct UpdateStatus {
    pub state: UpdateState,
    /// The latest successful check, as `check` returns it.
    release: Value,
    check_failed_at: Option<String>,
    /// The running updater while applying; its log stays named after a failure.
    applier: Option<std::process::Child>,
    log: Option<std::path::PathBuf>,
}

/// Why an update cannot start now.
pub enum ApplyRefused {
    AlreadyRunning,
    NothingNewer,
}

impl UpdateStatus {
    pub fn new(checking: bool) -> Self {
        Self {
            state: if checking {
                UpdateState::NotChecked
            } else {
                UpdateState::Disabled
            },
            release: Value::Null,
            check_failed_at: None,
            applier: None,
            log: None,
        }
    }

    pub fn checked(&mut self, result: Result<Value>, at: String) {
        match result {
            Ok(release) => {
                self.check_failed_at = None;
                // An update in progress is not undone by a check that happens to land meanwhile.
                if self.state != UpdateState::Applying {
                    self.state = if release["available"] == true {
                        UpdateState::Available
                    } else {
                        UpdateState::UpToDate
                    };
                }
                self.release = release;
            }
            Err(_) => self.check_failed_at = Some(at),
        }
    }

    /// Whether an update may start now. Only a known newer release that is not already being installed may.
    pub fn may_apply(&mut self) -> std::result::Result<(), ApplyRefused> {
        self.poll();
        match self.state {
            UpdateState::Applying => Err(ApplyRefused::AlreadyRunning),
            UpdateState::Available | UpdateState::ApplyFailed
                if self.release["available"] == true =>
            {
                Ok(())
            }
            _ => Err(ApplyRefused::NothingNewer),
        }
    }

    pub fn applying(&mut self, child: std::process::Child, log: std::path::PathBuf) {
        self.state = UpdateState::Applying;
        self.applier = Some(child);
        self.log = Some(log);
    }

    /// A successful update stops this service, so an updater that has exited while it still runs did not install.
    fn poll(&mut self) {
        if self.state != UpdateState::Applying {
            return;
        }
        if let Some(child) = self.applier.as_mut()
            && !matches!(child.try_wait(), Ok(None))
        {
            self.applier = None;
            self.state = UpdateState::ApplyFailed;
        }
    }

    /// The report the dashboard reads. `available` stays a plain flag, as earlier dashboards expect.
    pub fn report(&mut self) -> Value {
        self.poll();
        let mut v = if self.release.is_object() {
            self.release.clone()
        } else {
            json!({})
        };
        v["state"] = json!(self.state.name());
        v["current"] = json!(VERSION);
        v["available"] = json!(
            matches!(
                self.state,
                UpdateState::Available | UpdateState::ApplyFailed
            ) && self.release["available"] == true
        );
        if let Some(at) = &self.check_failed_at {
            v["check_failed_at"] = json!(at);
        }
        if let Some(log) = self
            .log
            .as_ref()
            .filter(|_| matches!(self.state, UpdateState::Applying | UpdateState::ApplyFailed))
        {
            v["log"] = json!(log);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backup_fixture(name: &str) -> (tempfile::TempDir, Config) {
        let temporary = tempfile::tempdir().unwrap();
        let mut config = Config::load_from(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.toml"),
        )
        .unwrap();
        config.storage.duckdb_path = temporary
            .path()
            .join("data")
            .join(name)
            .to_string_lossy()
            .into_owned();
        config.storage.archive_path = temporary
            .path()
            .join("archive")
            .to_string_lossy()
            .into_owned();
        config.storage.memory_limit_mb = 128;
        (temporary, config)
    }

    fn completed_backup(c: &Config) -> std::path::PathBuf {
        std::fs::read_dir(backups_dir(c))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.join("backup.complete.json").is_file())
            .unwrap()
    }

    #[test]
    fn custom_database_filename_recovers_committed_wal_in_backup() {
        if let Some(path) = std::env::var_os("RUNTRACE_TEST_BACKUP_WAL_PATH") {
            let (_temporary, mut config) = backup_fixture("worker.db");
            config.storage.duckdb_path = std::path::PathBuf::from(path)
                .to_string_lossy()
                .into_owned();
            let source = t3ui_core::storage::Store::open(&config).unwrap();
            source.conn.execute_batch("CREATE TABLE backup_recovery_probe(value INTEGER); INSERT INTO backup_recovery_probe VALUES(42)").unwrap();
            // Preserve committed WAL while the OS releases the writer handle.
            std::process::exit(0);
        }
        let (_temporary, config) = backup_fixture("history.db");
        assert!(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "update::tests::custom_database_filename_recovers_committed_wal_in_backup"
                ])
                .env("RUNTRACE_TEST_BACKUP_WAL_PATH", &config.storage.duckdb_path)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::fs::metadata(format!("{}.wal", config.storage.duckdb_path))
                .unwrap()
                .len()
                > 0
        );
        backup(&config, "v90.0.0").unwrap();
        let mut restored = config.clone();
        restored.storage.duckdb_path = completed_backup(&config)
            .join("database/history.db")
            .to_string_lossy()
            .into_owned();
        let copy = t3ui_core::storage::Store::open(&restored).unwrap();
        let value: i32 = copy
            .conn
            .query_row("SELECT value FROM backup_recovery_probe", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn legacy_database_without_cold_manifest_recovers_independently() {
        let (temporary, config) = backup_fixture("legacy.db");
        let source = t3ui_core::storage::Store::open(&config).unwrap();
        source.conn.execute_batch("DROP TABLE cold_segments; CREATE TABLE backup_recovery_probe(value INTEGER); INSERT INTO backup_recovery_probe VALUES(42)").unwrap();
        drop(source);
        backup(&config, "v90.0.0").unwrap();
        std::fs::rename(
            &config.storage.duckdb_path,
            temporary.path().join("unavailable-original.db"),
        )
        .unwrap();
        let mut restored = config.clone();
        restored.storage.duckdb_path = completed_backup(&config)
            .join("database/legacy.db")
            .to_string_lossy()
            .into_owned();
        let copy = t3ui_core::storage::Store::open(&restored).unwrap();
        let value: i32 = copy
            .conn
            .query_row("SELECT value FROM backup_recovery_probe", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn same_target_and_reserved_database_names_preserve_distinct_complete_backups() {
        for name in ["backup.complete.json", "backup.incomplete"] {
            let (_temporary, config) = backup_fixture(name);
            let source = t3ui_core::storage::Store::open(&config).unwrap();
            source.conn.execute_batch("CREATE TABLE backup_recovery_probe(value INTEGER); INSERT INTO backup_recovery_probe VALUES(42)").unwrap();
            drop(source);
            backup_at(&config, "v90.0.0", "same-second-fixture").unwrap();
            backup_at(&config, "v90.0.0", "same-second-fixture").unwrap();
            let copies: Vec<_> = std::fs::read_dir(backups_dir(&config))
                .unwrap()
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| completed_backup_time(path).is_some())
                .collect();
            assert_eq!(
                copies.len(),
                2,
                "same-second attempts must never overwrite a completed generation"
            );
            for directory in copies {
                let mut restored = config.clone();
                restored.storage.duckdb_path = directory
                    .join("database")
                    .join(name)
                    .to_string_lossy()
                    .into_owned();
                let copy = t3ui_core::storage::Store::open(&restored).unwrap();
                let value: i32 = copy
                    .conn
                    .query_row("SELECT value FROM backup_recovery_probe", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(
                    value, 42,
                    "database bytes cannot collide with backup markers"
                );
            }
        }
    }

    #[test]
    fn rollback_dependencies_and_completed_predecessor_survive_backup_rotation() {
        let (temporary, config) = backup_fixture("history.duckdb");
        let source = t3ui_core::storage::Store::open(&config).unwrap();
        source
            .put(
                "local",
                "instance",
                "neutral",
                "",
                "",
                "",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
                "partial",
                "v1",
                json!({"title":"Neutral rollback fixture"}),
            )
            .unwrap();
        t3ui_core::cold::compact(&config, &source).unwrap();
        drop(source);
        backup(&config, "v90.0.0").unwrap();
        let first = completed_backup(&config);
        std::fs::copy(
            first.join("database/history.duckdb"),
            &config.storage.duckdb_path,
        )
        .unwrap();
        backup(&config, "v90.0.1").unwrap();
        let second = std::fs::read_dir(backups_dir(&config))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p != &first)
            .unwrap();
        backup(&config, "v90.0.2").unwrap();
        let third = std::fs::read_dir(backups_dir(&config))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p != &first && p != &second)
            .unwrap();
        let segment = std::fs::read_dir(first.join("cold"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let unavailable = segment.with_extension("temporarily-unavailable");
        std::fs::rename(&segment, &unavailable).unwrap();
        let failed = backup(&config, "v90.0.99");
        std::fs::rename(&unavailable, &segment).unwrap();
        assert!(
            failed.is_err(),
            "a missing source segment must reject the new backup"
        );
        assert!(
            third.join("backup.complete.json").is_file(),
            "failure cannot retire the previous completed copy"
        );
        let partial = backups_dir(&config).join("before-update-partial-fixture");
        std::fs::create_dir_all(&partial).unwrap();
        std::fs::write(partial.join("backup.incomplete"), b"partial").unwrap();
        std::fs::write(partial.join("backup.complete.json"), b"{}").unwrap();
        backup(&config, "v90.0.3").unwrap();
        assert!(
            first.is_dir(),
            "active cold paths still depend on this rollback copy"
        );
        assert!(
            third.is_dir(),
            "the completed predecessor must remain available"
        );
        assert!(
            !second.exists(),
            "unreferenced older completed copies can rotate"
        );
        assert!(
            partial.is_dir(),
            "an incomplete attempt cannot replace the predecessor"
        );
        std::fs::rename(
            &config.storage.archive_path,
            temporary.path().join("unavailable-original-archive"),
        )
        .unwrap();
        let restored = t3ui_core::storage::Store::open(&config).unwrap();
        t3ui_core::cold::verify(&restored).unwrap();
        assert_eq!(
            restored.stats().unwrap()["rows"],
            json!([{"table":"instance","rows":1}])
        );
    }

    fn release(newer: bool) -> Result<Value> {
        Ok(
            json!({"current": VERSION, "latest": "9.9.9", "available": newer, "url": "https://example.test/r"}),
        )
    }

    #[test]
    fn checks_move_between_up_to_date_and_available_and_a_failure_forgets_nothing() {
        let mut u = UpdateStatus::new(true);
        assert_eq!(u.report()["state"], "not_checked");
        u.checked(release(true), "t1".into());
        assert_eq!(
            (u.state, u.report()["available"].clone()),
            (UpdateState::Available, json!(true))
        );
        u.checked(Err(anyhow::anyhow!("offline")), "t2".into());
        let j = u.report();
        assert_eq!(
            (
                j["state"].clone(),
                j["latest"].clone(),
                j["check_failed_at"].clone()
            ),
            (json!("available"), json!("9.9.9"), json!("t2"))
        );
        u.checked(release(false), "t3".into());
        assert_eq!(u.state, UpdateState::UpToDate);
        assert!(u.report().get("check_failed_at").is_none());
        assert!(matches!(u.may_apply(), Err(ApplyRefused::NothingNewer)));
        assert_eq!(UpdateStatus::new(false).report()["state"], "disabled");
    }

    #[test]
    fn one_update_at_a_time_and_an_updater_that_exits_early_has_failed() {
        let mut u = UpdateStatus::new(true);
        u.checked(release(true), "t1".into());
        assert!(u.may_apply().is_ok());
        // A short-lived process stands in for an updater that gives up before stopping the service.
        let quick = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", "ping -n 2 127.0.0.1 >NUL & exit 3"])
                .spawn()
        } else {
            Command::new("sh").args(["-c", "sleep 1; exit 3"]).spawn()
        };
        u.applying(quick.unwrap(), "update.log".into());
        assert!(
            matches!(u.may_apply(), Err(ApplyRefused::AlreadyRunning)),
            "a second update is refused while one runs"
        );
        u.checked(release(true), "t2".into());
        assert_eq!(
            u.state,
            UpdateState::Applying,
            "a check does not undo an update in progress"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while u.report()["state"] == "applying" && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let j = u.report();
        assert_eq!(
            (j["state"].clone(), j["log"].clone()),
            (json!("apply_failed"), json!("update.log"))
        );
        assert!(u.may_apply().is_ok(), "a failed update can be tried again");
    }
    #[test]
    fn versions_compare_by_number() {
        assert_eq!(parse_version("v0.10.2"), Some((0, 10, 2)));
        assert!(parse_version("v0.10.0") > parse_version("0.9.9"));
        assert_eq!(parse_version("1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_version("v2"), Some((2, 0, 0)));
        assert_eq!(parse_version("nightly"), None);
    }
}
