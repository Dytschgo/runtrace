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
    backup(c, tag)?;
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

/// Copies the database (with its write-ahead log) before an update, and keeps only the newest such copy.
fn backup(c: &Config, tag: &str) -> Result<()> {
    let db = Path::new(&c.storage.duckdb_path);
    if !db.exists() {
        return Ok(());
    }
    let root = backups_dir(c);
    let dir = root.join(format!(
        "before-update-{VERSION}-to-{}-{}",
        tag.trim_start_matches('v'),
        control::stamp()
    ));
    std::fs::create_dir_all(&dir)?;
    for file in [db.to_path_buf(), db.with_extension("duckdb.wal")] {
        if let (true, Some(n)) = (file.exists(), file.file_name()) {
            std::fs::copy(&file, dir.join(n))?;
        }
    }
    println!("Backed up the database to {}", dir.display());
    for old in std::fs::read_dir(&root)?.flatten() {
        let p = old.path();
        if p != dir
            && p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("before-update-"))
        {
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
    pub fn to_json(&mut self) -> Value {
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

    fn release(newer: bool) -> Result<Value> {
        Ok(
            json!({"current": VERSION, "latest": "9.9.9", "available": newer, "url": "https://example.test/r"}),
        )
    }

    #[test]
    fn checks_move_between_up_to_date_and_available_and_a_failure_forgets_nothing() {
        let mut u = UpdateStatus::new(true);
        assert_eq!(u.to_json()["state"], "not_checked");
        u.checked(release(true), "t1".into());
        assert_eq!(
            (u.state, u.to_json()["available"].clone()),
            (UpdateState::Available, json!(true))
        );
        u.checked(Err(anyhow::anyhow!("offline")), "t2".into());
        let j = u.to_json();
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
        assert!(u.to_json().get("check_failed_at").is_none());
        assert!(matches!(u.may_apply(), Err(ApplyRefused::NothingNewer)));
        assert_eq!(UpdateStatus::new(false).to_json()["state"], "disabled");
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
        while u.to_json()["state"] == "applying" && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let j = u.to_json();
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
