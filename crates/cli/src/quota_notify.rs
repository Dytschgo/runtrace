use anyhow::Result;
use serde_json::{Value, json};
use t3ui_core::{
    analytics,
    config::Config,
    quota_alerts,
    storage::{Store, clock},
};

pub fn run(c: &Config, s: &Store) -> Result<Value> {
    let now = clock();
    let mut report = if !c.quota.notifications {
        json!({"state":"disabled","shown":0,"failed":0})
    } else if !cfg!(windows) {
        json!({"state":"unsupported","reason":"Native quota notifications require Windows","shown":0,"failed":0})
    } else {
        let readings = analytics::query(s, "quota/current", &Default::default())?;
        quota_alerts::dispatch(
            s,
            true,
            now.timestamp_millis(),
            readings["data"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default(),
            native,
        )?
    };
    report["checked_at"] = json!(now.to_rfc3339());
    s.set("quota:notifications", &report.to_string())?;
    Ok(report)
}

#[cfg(not(windows))]
fn native(_: &quota_alerts::Alert) -> Result<()> {
    anyhow::bail!("Native quota notifications require Windows")
}

#[cfg(windows)]
fn native(alert: &quota_alerts::Alert) -> Result<()> {
    use std::{
        io::{BufRead, BufReader},
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        sync::mpsc,
        time::Duration,
    };
    // Text travels as environment data, never executable PowerShell source.
    // BalloonTipShown acknowledges actual shell display, rather than API launch.
    const SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notice=[System.Windows.Forms.NotifyIcon]::new()
try {
  $notice.Icon=[System.Drawing.SystemIcons]::Information
  $notice.Text='Runtrace quota'
  $notice.add_BalloonTipShown({[Console]::Out.WriteLine('RUNTRACE_QUOTA_SHOWN');[Console]::Out.Flush()})
  $notice.Visible=$true
  $notice.ShowBalloonTip(12000,$env:RUNTRACE_NOTIFY_TITLE,$env:RUNTRACE_NOTIFY_BODY,[System.Windows.Forms.ToolTipIcon]::Info)
  $until=[DateTime]::UtcNow.AddSeconds(16)
  while([DateTime]::UtcNow -lt $until) {[System.Windows.Forms.Application]::DoEvents();[Threading.Thread]::Sleep(50)}
} finally {$notice.Dispose()}
"#;
    let title = format!("Runtrace quota: {}% warning", alert.threshold);
    let body = format!(
        "{} / {}: {:.1}% left. Reset: {}",
        alert.provider, alert.window, alert.remaining_percentage, alert.reset_at
    );
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("RUNTRACE_NOTIFY_TITLE", title)
        .env("RUNTRACE_NOTIFY_BODY", body)
        .creation_flags(0x08000000)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let shown = BufReader::new(stdout).read_line(&mut line).is_ok()
            && line.trim() == "RUNTRACE_QUOTA_SHOWN";
        let _ = tx.send(shown);
    });
    if rx.recv_timeout(Duration::from_secs(8)) == Ok(true) {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    } else {
        let _ = child.kill();
        let _ = child.wait();
        anyhow::bail!("Windows did not acknowledge displaying the quota notification")
    }
}
