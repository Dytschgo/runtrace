//! Starting, stopping and finding the background service, the same way on Windows, macOS and Linux.
use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use t3ui_core::config::Config;

pub fn url(c: &Config) -> String {
    format!("http://127.0.0.1:{}", c.server.port)
}

/// The folder for logs and the process id: beside the data folder, so every install keeps its own.
pub fn run_dir(c: &Config) -> PathBuf {
    let data = Path::new(&c.storage.duckdb_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    data.parent().map(Path::to_path_buf).unwrap_or(data)
}

pub fn logs_dir(c: &Config) -> PathBuf {
    run_dir(c).join("logs")
}

fn pid_file(c: &Config) -> PathBuf {
    run_dir(c).join("runtrace.pid")
}

pub fn stamp() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string()
}

/// What the service on the configured port says about itself, if anything answers.
pub fn health(c: &Config) -> Option<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(1500)))
        .build()
        .into();
    agent
        .get(format!("{}/health/ready", url(c)))
        .call()
        .ok()?
        .body_mut()
        .read_json::<Value>()
        .ok()
}

/// The running service for this install: it answers on the port and reads the same database.
pub fn running(c: &Config) -> Option<Value> {
    let h = health(c)?;
    let ours = c.storage_identity().ok();
    (ours.is_some() && h["storage_identity"].as_str() == ours.as_deref()).then_some(h)
}

/// Starts a program that keeps running after this one exits, with its output in a log file.
pub fn spawn_detached(mut cmd: Command, log: &Path) -> Result<std::process::Child> {
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let out = std::fs::File::create(log)?;
    cmd.stdin(Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(out);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    Ok(cmd.spawn()?)
}

/// Brings the database up to date in the foreground, then starts the service in the background and waits until it answers.
pub fn start(c: &Config, config_path: &Path, open_after: bool) -> Result<()> {
    if running(c).is_some() {
        println!("Runtrace is already running at {}", url(c));
        if open_after {
            open(c)?;
        }
        return Ok(());
    }
    if health(c).is_some() {
        bail!(
            "Port {} is used by another program or another Runtrace install. Change server.port in {}",
            c.server.port,
            config_path.display()
        );
    }
    println!("Checking the database...");
    let began = Instant::now();
    drop(
        t3ui_core::storage::Store::open(c)
            .context("The database could not be opened or updated, so Runtrace was not started")?,
    );
    if began.elapsed() > Duration::from_secs(2) {
        println!("Database updated in {:.0} s", began.elapsed().as_secs_f64());
    }
    let log = logs_dir(c).join(format!("server-{}.log", stamp()));
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg("serve")
        .env("RUNTRACE_CONFIG", config_path)
        .env_remove("T3UI_CONFIG");
    let mut child = spawn_detached(cmd, &log)?;
    std::fs::write(pid_file(c), child.id().to_string())?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Some(code) = child.try_wait()? {
            bail!(
                "Runtrace stopped right after starting ({code}). See {}",
                log.display()
            );
        }
        if running(c).is_some_and(|h| h["pid"].as_u64() == Some(child.id() as u64)) {
            println!("Runtrace is running at {}", url(c));
            if open_after {
                open(c)?;
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    bail!(
        "Runtrace did not answer within a minute. See {}",
        log.display()
    )
}

/// Stops this install's service. Only a process that answers as this install is stopped.
pub fn stop(c: &Config) -> Result<bool> {
    let Some(h) = running(c) else {
        let _ = std::fs::remove_file(pid_file(c));
        return Ok(false);
    };
    let pid = h["pid"]
        .as_u64()
        .context("The service did not report its process id")?;
    kill(pid)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if health(c).is_none() {
            // The port closes a moment before the process lets go of the database.
            std::thread::sleep(Duration::from_millis(500));
            let _ = std::fs::remove_file(pid_file(c));
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    bail!("Runtrace (process {pid}) did not stop")
}

fn kill(pid: u64) -> Result<()> {
    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    #[cfg(not(windows))]
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()?;
    if !status.success() {
        bail!("Could not stop process {pid}");
    }
    Ok(())
}

pub fn status(c: &Config, config_path: &Path) {
    match running(c) {
        Some(h) => {
            println!(
                "Runtrace {} is running at {} (process {}).",
                h["version"].as_str().unwrap_or("?"),
                url(c),
                h["pid"]
            );
            if let Some(state) = h["collector"]["state"].as_str() {
                println!("Collector: {state}");
            }
        }
        None => println!("Runtrace is not running. Start it with `runtrace start`."),
    }
    println!("Settings: {}", config_path.display());
    println!("Database: {}", c.storage.duckdb_path);
    println!("Logs: {}", logs_dir(c).display());
}

/// Opens the dashboard in the default browser.
pub fn open(c: &Config) -> Result<()> {
    let u = url(c);
    #[cfg(windows)]
    let r = Command::new("cmd").args(["/C", "start", "", &u]).status();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&u).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(&u).status();
    if !r.is_ok_and(|s| s.success()) {
        println!("Open {u} in your browser.");
    }
    Ok(())
}

/// Starts Runtrace when this person logs in, or stops doing so.
pub fn autostart(on: bool, config_path: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let config = std::fs::canonicalize(config_path)?;
    #[cfg(windows)]
    {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let status = if on {
            let cmd = format!(
                "\"{}\" start --config \"{}\"",
                exe.display(),
                config.display()
            )
            .replace(r"\\?\", "");
            Command::new("reg")
                .args([
                    "add", key, "/v", "Runtrace", "/t", "REG_SZ", "/d", &cmd, "/f",
                ])
                .stdout(Stdio::null())
                .status()?
        } else {
            Command::new("reg")
                .args(["delete", key, "/v", "Runtrace", "/f"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?
        };
        if on && !status.success() {
            bail!("Could not register Runtrace to start at login");
        }
    }
    #[cfg(target_os = "macos")]
    {
        let dir = dirs::home_dir()
            .context("No home folder")?
            .join("Library/LaunchAgents");
        let file = dir.join("ch.runtrace.start.plist");
        if on {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(
                &file,
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>ch.runtrace.start</string><key>ProgramArguments</key><array><string>{}</string><string>start</string><string>--config</string><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>\n",
                    exe.display(),
                    config.display()
                ),
            )?;
        } else {
            let _ = std::fs::remove_file(&file);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = dirs::config_dir()
            .context("No config folder")?
            .join("autostart");
        let file = dir.join("runtrace.desktop");
        if on {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(
                &file,
                format!(
                    "[Desktop Entry]\nType=Application\nName=Runtrace\nExec=\"{}\" start --config \"{}\"\nX-GNOME-Autostart-enabled=true\n",
                    exe.display(),
                    config.display()
                ),
            )?;
        } else {
            let _ = std::fs::remove_file(&file);
        }
    }
    println!(
        "{}",
        if on {
            "Runtrace will start when you log in."
        } else {
            "Runtrace will no longer start at login."
        }
    );
    Ok(())
}
