//! Read only the sleep/wake timestamps of Windows' paired resume events.
use anyhow::Result;
use serde_json::{Value, json};
use t3ui_core::storage::{Store, clock, parse_time};

pub fn refresh(s: &Store) -> Result<()> {
    let previous: Value = s
        .setting("quota:power")
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or(Value::Null);
    let now = clock().timestamp_millis();
    if previous["checked_epoch_ms"]
        .as_i64()
        .is_some_and(|last| now >= last && now - last < 60 * 60_000)
    {
        return Ok(());
    }
    let report = match read() {
        Ok(events) => {
            json!({"state":"ready","checked_epoch_ms":now,"intervals":merge_intervals(&previous,intervals(&events,now),now)})
        }
        Err(_) => {
            json!({"state":"unavailable","checked_epoch_ms":now,"intervals":previous["intervals"].as_array().cloned().unwrap_or_default()})
        }
    };
    s.set("quota:power", &report.to_string())
}

fn merge_intervals(previous: &Value, mut fresh: Vec<Value>, now: i64) -> Vec<Value> {
    fresh.extend(
        previous["intervals"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| {
                v["source"] == "windows_power_event"
                    && v["sleep_epoch_ms"]
                        .as_i64()
                        .zip(v["wake_epoch_ms"].as_i64())
                        .is_some_and(|(sleep, wake)| sleep < wake && wake <= now)
            })
            .cloned(),
    );
    fresh.sort_by_key(|v| v["sleep_epoch_ms"].as_i64());
    fresh.dedup();
    fresh
}

fn intervals(events: &Value, now: i64) -> Vec<Value> {
    let mut intervals:Vec<Value>=events.as_array().into_iter().flatten().filter_map(|event| {
        let sleep=parse_time(event["sleep_at"].as_str()?)?.timestamp_millis();
        let wake=parse_time(event["wake_at"].as_str()?)?.timestamp_millis();
        (sleep<wake && wake<=now && wake>=now-31*24*60*60_000).then(||json!({"sleep_epoch_ms":sleep,"wake_epoch_ms":wake,"source":"windows_power_event"}))
    }).collect();
    intervals.sort_by_key(|v| v["sleep_epoch_ms"].as_i64());
    intervals.dedup();
    intervals
}

#[cfg(not(windows))]
fn read() -> Result<Value> {
    anyhow::bail!("Windows sleep history is unavailable on this platform")
}

#[cfg(windows)]
fn read() -> Result<Value> {
    use std::{
        io::Read,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    const SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  $events=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Power-Troubleshooter';Id=1;StartTime=(Get-Date).AddDays(-31)} -MaxEvents 256)
} catch {
  if($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {$events=@()} else {throw}
}
$pairs=@(foreach($event in $events) {
  $fields=@{}
  foreach($field in ([xml]$event.ToXml()).Event.EventData.Data) {
    if($field.Name -in @('SleepTime','WakeTime')) {$fields[$field.Name]=$field.'#text'}
  }
  if($fields.SleepTime -and $fields.WakeTime) {[pscustomobject]@{sleep_at=$fields.SleepTime;wake_at=$fields.WakeTime}}
})
ConvertTo-Json -InputObject $pairs -Compress
"#;
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = vec![];
        let result = stdout.take(128 * 1024).read_to_end(&mut bytes);
        result.map(|_| bytes)
    });
    let began = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            anyhow::ensure!(status.success(), "Windows sleep history could not be read");
            let bytes = reader
                .join()
                .map_err(|_| anyhow::anyhow!("Sleep history reader failed"))??;
            return Ok(serde_json::from_slice(&bytes)?);
        }
        if began.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            anyhow::bail!("Windows sleep history query timed out");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_valid_paired_event_times_become_sleep_evidence() {
        let now = parse_time("2026-11-17T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let pair = json!({"sleep_at":"2026-11-17T02:10:00Z","wake_at":"2026-11-17T06:40:00Z"});
        let data = json!([pair,pair,{"sleep_at":"unknown","wake_at":"2026-11-17T06:40:00Z"},{"sleep_at":"2026-11-18T02:10:00Z","wake_at":"2026-11-18T06:40:00Z"}]);
        let result = intervals(&data, now);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["source"], "windows_power_event");
        assert_eq!(
            result[0]["sleep_epoch_ms"],
            parse_time("2026-11-17T02:10:00Z")
                .unwrap()
                .timestamp_millis()
        );
    }
    #[test]
    fn recorded_sleep_is_kept_after_windows_prunes_its_event_history() {
        let old = json!({"sleep_epoch_ms":0,"wake_epoch_ms":60_000,"source":"windows_power_event"});
        let previous =
            json!({"intervals":[old,old,{"sleep_epoch_ms":-1,"wake_epoch_ms":0,"source":"guess"}]});
        assert_eq!(
            merge_intervals(&previous, vec![], 100 * 24 * 60 * 60_000),
            vec![old]
        );
    }
}
