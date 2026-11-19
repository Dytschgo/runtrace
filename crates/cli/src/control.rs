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

/// What answers on this install's port. Every command decides from this one answer.
pub enum Service {
    /// Nothing answers.
    Stopped,
    /// This install's service: it answers and reads the same database. Holds its health report.
    Running(Value),
    /// Something else answers: another program, or another Runtrace install with a different database.
    Foreign,
}

impl Service {
    pub fn name(&self) -> &'static str {
        match self {
            Service::Stopped => "stopped",
            Service::Running(_) => "running",
            Service::Foreign => "port_in_use",
        }
    }
}

pub fn probe(c: &Config) -> Service {
    let Some(h) = health(c) else {
        return Service::Stopped;
    };
    let ours = c.storage_identity().ok();
    if ours.is_some() && h["storage_identity"].as_str() == ours.as_deref() {
        Service::Running(h)
    } else {
        Service::Foreign
    }
}

/// This install's running service, if it is running.
pub fn running(c: &Config) -> Option<Value> {
    match probe(c) {
        Service::Running(h) => Some(h),
        _ => None,
    }
}

#[cfg(windows)]
mod stdio_inheritance {
    use std::ffi::c_void;
    use std::sync::{Mutex, MutexGuard};
    static SERIAL: Mutex<()> = Mutex::new(());
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(which: u32) -> *mut c_void;
        fn GetHandleInformation(handle: *mut c_void, flags: *mut u32) -> i32;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
    }
    pub struct Guard {
        handles: Vec<(*mut c_void, u32)>,
        _lock: MutexGuard<'static, ()>,
    }
    impl Guard {
        pub fn new() -> Self {
            let lock = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
            let mut saved = vec![];
            for which in [(-10i32) as u32, (-11i32) as u32, (-12i32) as u32] {
                // These borrowed process-standard handles stay owned by the runtime.
                // Only their inheritance bit changes; reads/writes are unaffected.
                unsafe {
                    let handle = GetStdHandle(which);
                    let mut flags = 0;
                    if !handle.is_null()
                        && handle as isize != -1
                        && GetHandleInformation(handle, &mut flags) != 0
                        && flags & 1 != 0
                        && SetHandleInformation(handle, 1, 0) != 0
                    {
                        saved.push((handle, flags & 1));
                    }
                }
            }
            Self {
                handles: saved,
                _lock: lock,
            }
        }
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            for (handle, flags) in &self.handles {
                // Restore the caller's flags after CreateProcess, including errors.
                unsafe {
                    SetHandleInformation(*handle, 1, *flags);
                }
            }
        }
    }
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
    // Windows can inherit unused native-command pipes in addition to the new
    // standard handles. A redirected PowerShell caller then waits for the server
    // to exit. The child gets its explicit log handles, never the caller's pipes.
    #[cfg(windows)]
    let _stdio = stdio_inheritance::Guard::new();
    Ok(cmd.spawn()?)
}

/// Brings the database up to date in the foreground, then starts the service in the background and waits until it answers.
pub fn start(c: &Config, config_path: &Path, open_after: bool) -> Result<()> {
    match probe(c) {
        Service::Running(_) => {
            println!("Runtrace is already running at {}", url(c));
            if open_after {
                open(c)?;
            }
            return Ok(());
        }
        Service::Foreign => bail!(
            "Port {} is used by another program or another Runtrace install. Change server.port in {}",
            c.server.port,
            config_path.display()
        ),
        Service::Stopped => {}
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
    std::fs::write(desired_file(c), b"running")?;
    let log = logs_dir(c).join(format!("supervisor-{}.log", stamp()));
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg("supervise")
        .env("RUNTRACE_CONFIG", config_path)
        .env_remove("T3UI_CONFIG");
    let mut child = spawn_detached(cmd, &log)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Some(code) = child.try_wait()? {
            bail!(
                "Runtrace stopped right after starting ({code}). See {}",
                log.display()
            );
        }
        if running(c).is_some() {
            println!("Runtrace is running at {}", url(c));
            if open_after {
                open(c)?;
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = stop(c);
    bail!(
        "Runtrace did not answer within a minute. See {}",
        log.display()
    )
}

/// Stops this install's service. Only a process that answers as this install is stopped.
pub fn stop(c: &Config) -> Result<bool> {
    let was_running = desired_file(c).exists() || running(c).is_some();
    // Clear intent before killing anything, including when the child is between restarts.
    match std::fs::remove_file(desired_file(c)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    // Wait for the supervisor to release its lifetime lock. This also lets updates
    // replace the executable on Windows without racing an automatic restart.
    let lock = supervisor_lock(c)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => bail!("Could not stop the supervisor: {e}"),
        }
    }
    let Some(h) = running(c) else {
        let _ = std::fs::remove_file(pid_file(c));
        return Ok(was_running);
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

pub fn status(c: &Config, config_path: &Path, as_json: bool) {
    let service = probe(c);
    if as_json {
        // For scripts and agents: one object naming the state, so nothing has to be read out of sentences.
        let h = match &service {
            Service::Running(h) => h.clone(),
            _ => Value::Null,
        };
        println!(
            "{}",
            serde_json::json!({
                "state": service.name(),
                "url": url(c),
                "version": h["version"],
                "pid": h["pid"],
                "collector": h["collector"],
                "program_version": crate::update::VERSION,
                "settings": config_path,
                "database": c.storage.duckdb_path,
                "logs": logs_dir(c),
            })
        );
        return;
    }
    match service {
        Service::Foreign => println!(
            "Port {} is used by another program or another Runtrace install, so this one cannot start there.",
            c.server.port
        ),
        Service::Running(h) => {
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
        Service::Stopped => println!("Runtrace is not running. Start it with `runtrace start`."),
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

fn desired_file(c: &Config) -> PathBuf {
    run_dir(c).join("runtrace.running")
}

fn supervisor_lock(c: &Config) -> Result<std::fs::File> {
    std::fs::create_dir_all(run_dir(c))?;
    Ok(std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(run_dir(c).join("runtrace.supervisor.lock"))?)
}

/// Owns one child and retries crashes until an explicit stop clears the intent file.
/// The OS releases this lock even if the supervisor itself exits unexpectedly.
pub fn supervise(c: &Config, config_path: &Path) -> Result<()> {
    let lock = supervisor_lock(c)?;
    if let Err(e) = lock.try_lock() {
        return match e {
            std::fs::TryLockError::WouldBlock => Ok(()),
            e => Err(anyhow::anyhow!("Cannot lock supervisor: {e}")),
        };
    }
    while desired_file(c).exists() {
        // Never adopt or terminate a process we did not create.
        if !matches!(probe(c), Service::Stopped) {
            bail!("The configured port is already occupied");
        }
        let log = logs_dir(c).join(format!("server-{}.log", stamp()));
        let mut cmd = Command::new(std::env::current_exe()?);
        cmd.arg("serve")
            .env("RUNTRACE_CONFIG", config_path)
            .env_remove("T3UI_CONFIG");
        match spawn_detached(cmd, &log) {
            Ok(mut child) => {
                std::fs::write(pid_file(c), child.id().to_string())?;
                loop {
                    if !desired_file(c).exists() {
                        let _ = child.kill();
                        child.wait()?;
                        let _ = std::fs::remove_file(pid_file(c));
                        return Ok(());
                    }
                    if let Some(code) = child.try_wait()? {
                        eprintln!("Service exited ({code}); retrying in two seconds");
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
            Err(e) => eprintln!("Service could not start: {e}; retrying in two seconds"),
        }
        // Bounded retry delay also keeps intentional stop responsive.
        for _ in 0..8 {
            if !desired_file(c).exists() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    Ok(())
}
