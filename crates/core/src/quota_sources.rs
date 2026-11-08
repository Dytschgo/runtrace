//! Quota as the coding agents record it on this machine. Nothing is estimated.
//!
//! - Codex writes its rate limits into every turn of its session logs: the percentage used of each window, when it resets,
//!   and the plan. Those logs are read from where they were left last time.
//! - Claude Code keeps its latest usage of the 5-hour and 7-day windows in `~/.claude.json`. Only that latest value exists,
//!   so its history is what this sampler sees from the moment it runs.
//! - Claude Code also logs every refusal for a reached limit, with the window and its reset, in its session logs.
use crate::storage::Store;
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const OFFSETS: &str = "quota:offsets";

/// The window named the way people say it, from its length.
pub fn window_name(minutes: i64) -> String {
    match minutes {
        300 => "five_hour".into(),
        1440 => "daily".into(),
        10080 => "weekly".into(),
        m => format!("{m}_minutes"),
    }
}

/// Resets are reported to the microsecond and drift by fractions of a second between samples, so they are kept to the minute.
fn minute(ms: i64) -> String {
    let rounded = (ms + 30_000).div_euclid(60_000) * 60_000;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(rounded)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn iso_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            files(&p, out);
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push(p);
        }
    }
}

/// The complete lines added to a log since the given offset, and the offset after the last complete one.
fn new_lines(path: &Path, from: u64) -> Option<(String, u64)> {
    let len = std::fs::metadata(path).ok()?.len();
    // A shorter file than before was rewritten, so it is read again from the start.
    let start = if len < from { 0 } else { from };
    if len == start {
        return None;
    }
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(len - start).read_to_end(&mut buf).ok()?;
    let end = buf.iter().rposition(|&b| b == b'\n')? + 1;
    buf.truncate(end);
    Some((
        String::from_utf8_lossy(&buf).into_owned(),
        start + end as u64,
    ))
}

struct Writer<'a> {
    s: &'a Store,
    samples: u64,
    events: u64,
    last: HashMap<(String, String), (String, Option<f64>)>,
    /// Resets already seen per provider and window, so one reported a minute differently is the same reset.
    resets: HashMap<(String, String), Vec<i64>>,
}

/// How far apart two reported resets can be and still be the same one.
const SAME_RESET_MS: i64 = 5 * 60_000;

impl Writer<'_> {
    /// The reset as first seen, if one within a few minutes is already known, so a window is not split by jitter.
    fn settle(&mut self, provider: &str, window: &str, reset_ms: i64) -> String {
        let known = self
            .resets
            .entry((provider.to_string(), window.to_string()))
            .or_default();
        let at = match known
            .iter()
            .find(|&&k| (k - reset_ms).abs() <= SAME_RESET_MS)
        {
            Some(&k) => k,
            None => {
                known.push(reset_ms);
                reset_ms
            }
        };
        minute(at)
    }
    #[allow(clippy::too_many_arguments)]
    fn sample(
        &mut self,
        provider: &str,
        window: &str,
        at: &str,
        used: Option<f64>,
        reset: &str,
        minutes: Option<i64>,
        plan: Option<&str>,
        source: &str,
    ) -> Result<()> {
        // A turn repeats the same reading many times, so only a change, or the first reading of a log, is kept.
        let key = (provider.to_string(), window.to_string());
        if self.last.get(&key) == Some(&(reset.to_string(), used)) {
            return Ok(());
        }
        self.last.insert(key, (reset.to_string(), used));
        let n = self.s.conn.execute(
            "INSERT INTO quota_samples VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            duckdb::params![provider, window, at, used, reset, minutes, plan, source],
        )?;
        self.samples += n as u64;
        Ok(())
    }
    fn event(
        &mut self,
        provider: &str,
        kind: &str,
        at: &str,
        window: Option<&str>,
        reset: Option<&str>,
        source: &str,
    ) -> Result<()> {
        let n = self.s.conn.execute(
            "INSERT INTO quota_events VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            duckdb::params![provider, kind, at, window, reset, source],
        )?;
        self.events += n as u64;
        Ok(())
    }
}

fn codex_line(w: &mut Writer, provider: &str, line: &str) -> Result<()> {
    if !line.contains("\"rate_limits\"") {
        return Ok(());
    }
    let Ok(j) = serde_json::from_str::<Value>(line) else {
        return Ok(());
    };
    let Some(at) = j["timestamp"].as_str() else {
        return Ok(());
    };
    let rl = &j["payload"]["rate_limits"];
    let plan = rl["plan_type"].as_str();
    for slot in ["primary", "secondary"] {
        let r = &rl[slot];
        let (Some(used), Some(minutes), Some(reset)) = (
            r["used_percent"].as_f64(),
            r["window_minutes"].as_i64(),
            r["resets_at"].as_i64(),
        ) else {
            continue;
        };
        let window = window_name(minutes);
        let reset = w.settle(provider, &window, reset * 1000);
        w.sample(
            provider,
            &window,
            at,
            Some(used),
            &reset,
            Some(minutes),
            plan,
            "codex_session_log",
        )?;
    }
    if let Some(kind) = rl["rate_limit_reached_type"].as_str() {
        w.event(
            provider,
            "limit_reached",
            at,
            Some(kind),
            None,
            "codex_session_log",
        )?;
    }
    Ok(())
}

fn claude_line(w: &mut Writer, line: &str) -> Result<()> {
    if !line.contains("rateLimitType") {
        return Ok(());
    }
    let Ok(j) = serde_json::from_str::<Value>(line) else {
        return Ok(());
    };
    let limits = if j["quotaLimits"].is_object() {
        &j["quotaLimits"]
    } else {
        &j["apiErrorParams"]["rate_limit_info"]
    };
    if limits["status"].as_str() != Some("rejected") {
        return Ok(());
    }
    let (Some(at), Some(window)) = (j["timestamp"].as_str(), limits["rateLimitType"].as_str())
    else {
        return Ok(());
    };
    let reset = limits["resetsAt"]
        .as_i64()
        .map(|s| w.settle("claude", window, s * 1000));
    w.event(
        "claude",
        "limit_reached",
        at,
        Some(window),
        reset.as_deref(),
        "claude_session_log",
    )
}

/// Reads what is new since last time. Called on every sync, so it stays current within a minute.
pub fn collect(s: &Store) -> Result<Value> {
    let home = PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))?);
    let mut offsets: HashMap<String, u64> = s
        .setting(OFFSETS)
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let mut w = Writer {
        s,
        samples: 0,
        events: 0,
        last: HashMap::new(),
        resets: HashMap::new(),
    };
    {
        let mut stmt = s.conn.prepare("SELECT DISTINCT provider, window_kind, reset_at FROM quota_samples UNION SELECT DISTINCT provider, window_kind, reset_at FROM quota_events WHERE reset_at IS NOT NULL")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (provider, window, reset) = row?;
            if let Some(ms) = iso_ms(&reset) {
                w.resets.entry((provider, window)).or_default().push(ms);
            }
        }
    }
    s.conn.execute_batch("BEGIN")?;
    let result = (|| -> Result<()> {
        // Codex, including its separate homes for other accounts.
        for (dir, provider) in [
            (".codex", "codex"),
            (".codex-meta", "codex-meta"),
            (".codex-ollama", "codex-ollama"),
        ] {
            let mut list = vec![];
            files(&home.join(dir).join("sessions"), &mut list);
            for path in list {
                let key = path.to_string_lossy().into_owned();
                let Some((text, end)) = new_lines(&path, offsets.get(&key).copied().unwrap_or(0))
                else {
                    continue;
                };
                w.last.clear();
                for line in text.lines() {
                    codex_line(&mut w, provider, line)?;
                }
                offsets.insert(key, end);
            }
        }
        // Claude Code's refusals.
        let mut list = vec![];
        files(&home.join(".claude").join("projects"), &mut list);
        for path in list {
            let key = path.to_string_lossy().into_owned();
            let Some((text, end)) = new_lines(&path, offsets.get(&key).copied().unwrap_or(0))
            else {
                continue;
            };
            for line in text.lines() {
                claude_line(&mut w, line)?;
            }
            offsets.insert(key, end);
        }
        // Claude Code's latest reading of its windows.
        if let Ok(raw) = std::fs::read_to_string(home.join(".claude.json"))
            && let Ok(j) = serde_json::from_str::<Value>(&raw)
        {
            let usage = &j["cachedUsageUtilization"];
            if let (Some(fetched), Some(windows)) = (
                usage["fetchedAtMs"].as_i64(),
                usage["utilization"].as_object(),
            ) {
                let at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(fetched)
                    .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .unwrap_or_default();
                for (window, v) in windows {
                    let (Some(used), Some(reset)) = (
                        v["utilization"].as_f64(),
                        v["resets_at"].as_str().and_then(iso_ms),
                    ) else {
                        continue;
                    };
                    let minutes = match window.as_str() {
                        "five_hour" => Some(300),
                        "seven_day" | "seven_day_opus" | "seven_day_sonnet" => Some(10_080),
                        _ => None,
                    };
                    let reset = w.settle("claude", window, reset);
                    w.sample(
                        "claude",
                        window,
                        &at,
                        Some(used),
                        &reset,
                        minutes,
                        None,
                        "claude_usage_cache",
                    )?;
                }
            }
        }
        Ok(())
    })();
    match &result {
        Ok(()) => {
            s.set(OFFSETS, &serde_json::to_string(&offsets)?)?;
            s.conn.execute_batch("COMMIT")?;
        }
        Err(_) => {
            let _ = s.conn.execute_batch("ROLLBACK");
        }
    }
    result?;
    Ok(json!({"samples_added": w.samples, "events_added": w.events}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_are_named_by_length() {
        assert_eq!(window_name(300), "five_hour");
        assert_eq!(window_name(10080), "weekly");
        assert_eq!(window_name(90), "90_minutes");
    }

    #[test]
    fn resets_round_to_the_minute() {
        assert_eq!(minute(1_794_612_660_000), "2026-11-13T23:31:00Z");
        assert_eq!(minute(1_794_612_659_671), "2026-11-13T23:31:00Z");
        assert_eq!(minute(1_794_612_629_000), "2026-11-13T23:30:00Z");
    }
}
