//! Quota as the coding agents record it on this machine. Nothing is estimated.
//!
//! - Codex writes its rate limits into every turn of its session logs: the percentage used of each window, when it resets,
//!   and the plan. Those logs are read from where they were left last time.
//! - Claude Code keeps its latest usage of the 5-hour and 7-day windows in `~/.claude.json`. Only that latest value exists,
//!   so its history is what this sampler sees from the moment it runs.
//! - Claude Code also logs every refusal for a reached limit, with the window and its reset, in its session logs.
//! - T3 Code asks each harness for its limits every few minutes and after turns, and keeps the latest answer per harness in
//!   `.t3/caches/<harness>.json`. That covers every harness T3 can ask (Claude Code, Codex, Grok…), so it is both the
//!   live view and a steady stream of readings.
//! - For harnesses T3 does not check, Runtrace asks them itself (see `quota_checks`), and those answers join the same
//!   readings and live view. A Codex home that runs models on this machine is marked as having no limit.
//! - Muse logs a refusal for an exhausted subscription, with its reset, in its session logs.
use crate::storage::Store;
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const OFFSETS: &str = "quota:offsets";
/// The latest limits of every harness T3 knows, as read on the last sync.
pub const LIVE: &str = "quota:live";
/// A reading that has not changed is still kept this often, so a window's readings show it was watched the whole time.
const HEARTBEAT_MS: i64 = 15 * 60_000;

struct QuotaTransaction<'a> {
    connection: &'a duckdb::Connection,
    committed: bool,
}
impl QuotaTransaction<'_> {
    fn commit(mut self) -> Result<()> {
        self.connection.execute_batch("COMMIT")?;
        self.committed = true;
        Ok(())
    }
}
impl Drop for QuotaTransaction<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.connection.execute_batch("ROLLBACK");
        }
    }
}

/// T3's cache folder, next to the folder that holds its database (`.t3/userdata/statev2.sqlite` → `.t3/caches`).
pub fn t3_caches(sqlite_path: &str) -> Option<PathBuf> {
    Path::new(sqlite_path)
        .parent()?
        .parent()
        .map(|t3| t3.join("caches"))
}

/// Quota is keyed by the name it had before T3 reported it, so Claude Code's history stays one line.
fn quota_key(harness: &str) -> &str {
    if harness == "claudeAgent" {
        "claude"
    } else {
        harness
    }
}

/// A window T3 reported, named like the same window from the other sources: Claude's own ids, else by its length.
fn t3_window(w: &Value) -> (String, Option<i64>) {
    let minutes = w["windowDurationMins"]
        .as_i64()
        .or_else(|| match w["kind"].as_str() {
            Some("weekly") => Some(10_080),
            Some("daily") => Some(1_440),
            _ => None,
        });
    let id = w["id"].as_str().unwrap_or("");
    let name = if id.starts_with("five_hour")
        || id.starts_with("seven_day")
        || ["weekly", "daily"].contains(&id)
    {
        id.to_string()
    } else if let Some(m) = minutes {
        window_name(m)
    } else {
        w["kind"].as_str().unwrap_or(id).to_string()
    };
    (name, minutes)
}

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
    /// The newest reading stored per provider and window: when, how much was used, and its reset.
    stored: HashMap<(String, String), (i64, Option<f64>, String)>,
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
        self.insert(provider, window, at, used, reset, minutes, plan, source)
    }
    /// A reading from a source that is read again and again: kept when it changed, or when the last one kept is older than
    /// the heartbeat. One no newer than what is stored adds nothing.
    #[allow(clippy::too_many_arguments)]
    fn keep(
        &mut self,
        provider: &str,
        window: &str,
        at: &str,
        used: Option<f64>,
        reset: &str,
        minutes: Option<i64>,
        source: &str,
    ) -> Result<()> {
        let Some(at_ms) = iso_ms(at) else {
            return Ok(());
        };
        if let Some((last_ms, last_used, last_reset)) =
            self.stored.get(&(provider.to_string(), window.to_string()))
            && (at_ms <= *last_ms
                || (*last_used == used && last_reset == reset && at_ms - last_ms < HEARTBEAT_MS))
        {
            return Ok(());
        }
        self.insert(provider, window, at, used, reset, minutes, None, source)
    }
    #[allow(clippy::too_many_arguments)]
    fn insert(
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
        let n = self.s.conn.execute(
            "INSERT INTO quota_samples SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM cold_quota_sample_keys WHERE provider=? AND window_kind=? AND sampled_at=?) ON CONFLICT DO NOTHING",
            duckdb::params![provider, window, at, used, reset, minutes, plan, source,provider,window,at],
        )?;
        self.samples += n as u64;
        if let Some(at_ms) = iso_ms(at) {
            let key = (provider.to_string(), window.to_string());
            if self.stored.get(&key).is_none_or(|(last, ..)| at_ms > *last) {
                self.stored.insert(key, (at_ms, used, reset.to_string()));
            }
        }
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
            "INSERT INTO quota_events SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM cold_quota_event_keys WHERE provider=? AND kind=? AND happened_at=?) ON CONFLICT DO NOTHING",
            duckdb::params![provider, kind, at, window, reset, source,provider,kind,at],
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

/// What T3 last heard from each harness about its limits. Readings go into the history; the whole answer, with reset
/// credits and why a harness reports nothing, is returned for the live view. Disabled harnesses with nothing to show are
/// left out, and nothing about the account (such as its sign-in) is copied.
fn t3_cache(w: &mut Writer, dir: &Path) -> Result<Vec<Value>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(vec![]);
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    let mut out = vec![];
    for path in paths {
        let Some(j) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        else {
            continue;
        };
        // Only a harness's cache names the program that drives it.
        if !j["driver"].is_string() {
            continue;
        }
        let Some(harness) = j["instanceId"]
            .as_str()
            .map(str::to_string)
            .or_else(|| Some(path.file_stem()?.to_string_lossy().into_owned()))
        else {
            continue;
        };
        let limits = &j["usageLimits"];
        let enabled = j["enabled"].as_bool().unwrap_or(false);
        let reported = limits["windows"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        if !enabled && reported.is_empty() {
            continue;
        }
        let key = quota_key(&harness).to_string();
        let checked = limits["checkedAt"].as_str();
        let mut names = std::collections::HashSet::new();
        let mut windows = vec![];
        for win in reported {
            let (mut name, minutes) = t3_window(win);
            if !names.insert(name.clone()) {
                name = win["id"].as_str().unwrap_or(&name).to_string();
            }
            let used = win["usedPercent"].as_f64();
            let reset = win["resetsAt"]
                .as_str()
                .and_then(iso_ms)
                .map(|ms| w.settle(&key, &name, ms));
            if let (Some(at), Some(reset), Some(_)) = (checked, &reset, used) {
                w.keep(&key, &name, at, used, reset, minutes, "t3_usage_cache")?;
            }
            windows.push(json!({"window":name,"label":win["label"],"kind":win["kind"],"used_percentage":used,"reset_at":reset,"window_minutes":minutes}));
        }
        let c = &limits["resetCredits"];
        let credits = c.is_object().then(|| {
            let options: Vec<Value> = c["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| json!({"label":o["label"],"description":o["description"],"available":o["availableCount"],"expires_at":o["expiresAt"]}))
                .collect();
            json!({"available":c["availableCount"],"next_expires_at":c["nextExpiresAt"],"options":options})
        });
        let u = &limits["unavailable"];
        let local = (reported.is_empty() && j["driver"] == "codex")
            .then(|| {
                j["continuation"]["groupKey"]
                    .as_str()?
                    .strip_prefix("codex:home:")
            })
            .flatten()
            .and_then(|home| codex_local(Path::new(home)));
        let unavailable = match local {
            Some(by) => Some(
                json!({"reason":"local","message":format!("Runs models on this machine through {by}, so it has no limit")}),
            ),
            None => u
                .is_object()
                .then(|| json!({"reason":u["reason"],"message":u["message"]})),
        };
        out.push(json!({
            "harness": harness,
            "driver": j["driver"],
            "name": j["displayName"],
            "enabled": enabled,
            "status": j["status"],
            "quota_key": key,
            "reports_limits": limits.is_object(),
            "checked_at": checked,
            "checked_by": "t3",
            "windows": windows,
            "credits": credits,
            "unavailable": unavailable,
        }));
    }
    Ok(out)
}

/// The program a Codex home runs its models through, when that is this machine: a built-in local provider, or one whose
/// address is the local host. `None` for a home that uses an account with limits.
fn codex_local(home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(home.join("config.toml")).ok()?;
    let config: toml::Value = toml::from_str(&raw).ok()?;
    let id = config.get("model_provider")?.as_str()?;
    match id {
        "ollama" => return Some("Ollama".into()),
        "lmstudio" => return Some("LM Studio".into()),
        _ => {}
    }
    let provider = config.get("model_providers")?.get(id)?;
    let url = provider.get("base_url")?.as_str()?;
    let host = url.split("://").nth(1).unwrap_or(url);
    let local = ["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|h| host.starts_with(h));
    local.then(|| {
        let name = provider.get("name").and_then(|n| n.as_str()).unwrap_or(id);
        // "Ollama (localhost)" reads as Ollama.
        name.split(" (").next().unwrap_or(name).to_string()
    })
}

/// Muse logs an exhausted subscription with the reset it waits for, inside its session records.
fn muse_line(w: &mut Writer, line: &str) -> Result<()> {
    static RESET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"quota exhausted\. Your usage window resets at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)",
        )
        .unwrap()
    });
    static AT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"recorded_at\\?"\s*:\s*(\d{13,17})"#).unwrap()
    });
    if !line.contains("quota exhausted") {
        return Ok(());
    }
    for m in RESET.captures_iter(line) {
        let start = m.get(0).map_or(0, |x| x.start());
        // The record the refusal belongs to is the last one stamped before it.
        let Some(micros) = AT
            .captures_iter(&line[..start])
            .last()
            .and_then(|c| c[1].parse::<i64>().ok())
        else {
            continue;
        };
        let Some(at) = chrono::DateTime::<chrono::Utc>::from_timestamp_micros(micros)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        else {
            continue;
        };
        let reset = iso_ms(&m[1]).map(|ms| w.settle("muse", "usage_window", ms));
        w.event(
            "muse",
            "limit_reached",
            &at,
            Some("usage_window"),
            reset.as_deref(),
            "muse_session_log",
        )?;
    }
    Ok(())
}

/// A harness Runtrace checked itself, as a live row like T3's, with its readings kept the same way.
fn checked_row(w: &mut Writer, harness: &str, c: &Value) -> Result<Value> {
    let checked = c["checked_at"].as_str();
    let mut windows = vec![];
    for win in c["windows"].as_array().into_iter().flatten() {
        let Some(name) = win["window"].as_str() else {
            continue;
        };
        let used = win["used_percentage"].as_f64();
        let minutes = win["window_minutes"].as_i64();
        let reset = win["reset_at"]
            .as_str()
            .and_then(iso_ms)
            .map(|ms| w.settle(harness, name, ms));
        if let (Some(at), Some(reset), Some(_)) = (checked, &reset, used) {
            w.keep(harness, name, at, used, reset, minutes, "runtrace_check")?;
        }
        windows.push(json!({"window":name,"label":win["label"],"used_percentage":used,"reset_at":reset,"window_minutes":minutes}));
    }
    Ok(json!({
        "harness": harness,
        "driver": harness,
        "name": c["name"],
        "enabled": true,
        "status": "ready",
        "quota_key": harness,
        "reports_limits": true,
        "checked_at": checked,
        "checked_by": "runtrace",
        "plan": c["plan"],
        "windows": windows,
        "credits": null,
        "unavailable": c["unavailable"],
    }))
}

/// Reads what is new since last time. Called on every sync, so it stays current within a minute.
/// `t3_caches` is T3's cache folder, when there is one; see [`t3_caches`].
pub fn collect(s: &Store, t3_caches: Option<&Path>) -> Result<Value> {
    let home = PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))?);
    collect_from(s, &home, t3_caches)
}

/// [`collect`] with the agents' home folder given, so a test can point it at its own.
pub fn collect_from(s: &Store, home: &Path, t3_caches: Option<&Path>) -> Result<Value> {
    // Manifest, hot rows and sampling offsets must share one snapshot while
    // cold maintenance is running on the independent import connection.
    s.conn.execute_batch("BEGIN")?;
    let transaction = QuotaTransaction {
        connection: &s.conn,
        committed: false,
    };
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
        stored: HashMap::new(),
    };
    let samples = crate::cold::source(&s.conn, "quota_samples", s.content_retention_days)?;
    let events = crate::cold::source(&s.conn, "quota_events", s.content_retention_days)?;
    {
        let mut stmt = s.conn.prepare(&format!("SELECT provider, window_kind, max(sampled_at), arg_max(used_percent, sampled_at), arg_max(reset_at, sampled_at) FROM {samples} GROUP BY ALL"))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<f64>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?;
        for row in rows {
            let (provider, window, at, used, reset) = row?;
            if let Some(ms) = iso_ms(&at) {
                w.stored
                    .insert((provider, window), (ms, used, reset.unwrap_or_default()));
            }
        }
    }
    {
        let mut stmt = s.conn.prepare(&format!("SELECT DISTINCT provider, window_kind, reset_at FROM {samples} UNION SELECT DISTINCT provider, window_kind, reset_at FROM {events} WHERE reset_at IS NOT NULL"))?;
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
        // Muse's refusals.
        let mut list = vec![];
        files(
            &home
                .join(".local")
                .join("share")
                .join("muse")
                .join("sessions"),
            &mut list,
        );
        for path in list {
            let key = path.to_string_lossy().into_owned();
            let Some((text, end)) = new_lines(&path, offsets.get(&key).copied().unwrap_or(0))
            else {
                continue;
            };
            for line in text.lines() {
                muse_line(&mut w, line)?;
            }
            offsets.insert(key, end);
        }
        // Every harness T3 asks, last so its readings follow the ones above, then the ones Runtrace asks itself.
        let mut harnesses = match t3_caches {
            Some(dir) => t3_cache(&mut w, dir)?,
            None => vec![],
        };
        let checks: serde_json::Map<String, Value> = s
            .setting(crate::quota_checks::CHECKS)
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default();
        for (harness, c) in &checks {
            let row = checked_row(&mut w, harness, c)?;
            match harnesses
                .iter()
                .position(|h| h["harness"] == harness.as_str())
            {
                Some(i) => harnesses[i] = row,
                None => harnesses.push(row),
            }
        }
        if t3_caches.is_some() || !harnesses.is_empty() {
            s.set(
                LIVE,
                &json!({"read_at": crate::storage::now(), "harnesses": harnesses}).to_string(),
            )?;
        }
        Ok(())
    })();
    result?;
    s.set(OFFSETS, &serde_json::to_string(&offsets)?)?;
    transaction.commit()?;
    Ok(json!({"samples_added": w.samples, "events_added": w.events}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_history_read_releases_sampling_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let mut config: crate::config::Config =
            toml::from_str(include_str!("../../../config/default.toml")).unwrap();
        config.storage.duckdb_path = temp.path().join("test.duckdb").to_string_lossy().into();
        config.storage.archive_path = temp.path().join("archive").to_string_lossy().into();
        let store = Store::open(&config).unwrap();
        store
            .conn
            .execute_batch("DROP TABLE quota_samples")
            .unwrap();
        assert!(collect_from(&store, temp.path(), None).is_err());
        // A subsequent operation can own a fresh transaction, including callers
        // of standalone collect that continue maintenance after a quota error.
        store.conn.execute_batch("BEGIN; ROLLBACK").unwrap();
    }

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
