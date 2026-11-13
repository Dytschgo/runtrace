//! Runtrace's own limit checks, for harnesses T3 Code does not check. Like T3, it asks the harness's own program, every
//! few minutes, and keeps the latest answer; nothing is estimated and no sign-in is read or copied.
//!
//! - Antigravity: `agy -p /usage --output-format json` prints what is left of each model group's weekly limit.
//! - Muse: `muse serve` answers `usage/refresh` with the subscription and, when Meta sends one, its usage.
//!
//! The answers are saved in one setting; the quota collector turns them into readings and live rows.
use crate::storage::Store;
use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The latest answer of each check, by harness.
pub const CHECKS: &str = "quota:checks";
/// How often each harness is asked, like T3's own checks.
const EVERY_MS: i64 = 5 * 60_000;
const TIMEOUT: Duration = Duration::from_secs(60);

/// A harness Runtrace can ask itself, and the program it asks.
struct Check {
    harness: &'static str,
    name: &'static str,
    find: fn() -> Option<PathBuf>,
    run: fn(&Path) -> Result<Option<Value>>,
}

const ALL: [Check; 2] = [
    Check {
        harness: "antigravity",
        name: "Antigravity",
        find: agy_bin,
        run: antigravity,
    },
    Check {
        harness: "muse",
        name: "Muse",
        find: muse_bin,
        run: muse,
    },
];

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

fn agy_bin() -> Option<PathBuf> {
    on_path(&["agy.exe", "agy"])
}

/// Muse's launcher checks for updates through PowerShell on every start, so the program it launches is run directly.
fn muse_bin() -> Option<PathBuf> {
    let launcher = on_path(&["muse.cmd", "muse.exe", "muse"])?;
    let dir = launcher.parent()?;
    let newest = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with("muse-bin-") && n.ends_with(".exe")
        })
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path());
    newest.or_else(|| (launcher.extension().is_none_or(|x| x != "cmd")).then_some(launcher))
}

fn command(bin: &Path) -> Command {
    let mut c = Command::new(bin);
    // Neither program needs a project; the temporary folder keeps them from treating Runtrace's folder as one.
    c.current_dir(std::env::temp_dir());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashes up from the background service.
        c.creation_flags(0x0800_0000);
    }
    c
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// One weekly or daily window as the collector stores it. `left` is a fraction of the window still available.
fn window(
    name: String,
    label: String,
    minutes: Option<i64>,
    used: f64,
    reset: Option<String>,
) -> Value {
    json!({"window": name, "label": label, "window_minutes": minutes, "used_percentage": used, "reset_at": reset})
}

fn slug(text: &str) -> String {
    let s: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    s.split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// Antigravity's `/usage` answer: groups of models that share a limit, each with buckets of what is left.
pub fn antigravity_usage(out: &Value) -> Vec<Value> {
    let mut windows = vec![];
    for g in out["command"]["data"]["groups"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let group = g["name"].as_str().unwrap_or("Models");
        let short = group
            .strip_suffix(" Models")
            .or_else(|| group.strip_suffix(" models"))
            .unwrap_or(group);
        for b in g["buckets"].as_array().into_iter().flatten() {
            let Some(left) = b["remaining_fraction"].as_f64() else {
                continue;
            };
            let (minutes, prefix, period) = match b["window"].as_str() {
                Some("weekly") => (Some(10_080), "seven_day", "Weekly"),
                Some("daily") => (Some(1_440), "daily", "Daily"),
                _ => (None, "window", "Limit"),
            };
            let used = ((1.0 - left) * 1000.0).round() / 10.0;
            // A limit nobody has used yet shows a reset a full window from now, which moves with every check.
            let reset = (left < 1.0)
                .then(|| b["reset_time"].as_str().map(str::to_string))
                .flatten();
            windows.push(window(
                format!("{prefix}_{}", slug(short)),
                format!("{period} · {short}"),
                minutes,
                used,
                reset,
            ));
        }
    }
    windows
}

fn antigravity(bin: &Path) -> Result<Option<Value>> {
    let mut child = command(bin)
        .args(["-p", "/usage", "--output-format", "json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().context("no output")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let out = rx.recv_timeout(TIMEOUT);
    stop(&mut child);
    let out = out.map_err(|_| anyhow!("Antigravity did not answer within a minute"))?;
    let j: Value = serde_json::from_str(out.trim()).context("Antigravity's answer was not JSON")?;
    let windows = antigravity_usage(&j);
    Ok(Some(if windows.is_empty() {
        json!({"windows": [], "unavailable": {"reason": "probeFailed", "message": format!("Antigravity reported no limits ({})", j["status"].as_str().unwrap_or("no status"))}})
    } else {
        json!({"windows": windows})
    }))
}

/// Muse's `usage/refresh` answer. `None` when Muse asks to wait before the next refresh, so the last answer stands.
pub fn muse_usage(result: &Value) -> Value {
    let usage = &result["usage"];
    let plan = result["tierName"].as_str();
    if !usage.is_object() {
        let unavailable = if result["subscriptionActive"].as_bool() == Some(false) {
            json!({"reason": "noSubscription", "message": "No Muse subscription on this sign-in, so there is no limit to show"})
        } else {
            json!({"reason": "noUsageData", "message": "Subscribed, but Meta sends no usage numbers yet"})
        };
        return json!({"plan": plan, "windows": [], "unavailable": unavailable});
    }
    let reset = |ms: &Value| {
        ms.as_i64()
            .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    };
    let mut windows = vec![];
    let w = &usage["window"];
    if let Some(used) = w["usedPercent"].as_f64() {
        let minutes = w["windowDurationMins"].as_i64();
        let label = match minutes {
            Some(300) => "5-hour".to_string(),
            Some(m) if m % 60 == 0 => format!("{}-hour", m / 60),
            _ => "Window".to_string(),
        };
        windows.push(window(
            minutes.map_or("window".into(), crate::quota_sources::window_name),
            label,
            minutes,
            used,
            reset(&w["resetsAtMs"]),
        ));
    }
    let wk = &usage["weekly"];
    if let Some(used) = wk["usedPercent"].as_f64() {
        windows.push(window(
            "weekly".into(),
            "Weekly".into(),
            Some(10_080),
            used,
            reset(&wk["resetsAtMs"]),
        ));
    }
    json!({"plan": plan, "windows": windows})
}

fn muse(bin: &Path) -> Result<Option<Value>> {
    let mut child = command(bin)
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child.stdin.take().context("no input")?;
    let stdout = child.stdout.take().context("no output")?;
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line)
                && v.get("id").is_some()
                && tx.send(v).is_err()
            {
                break;
            }
        }
    });
    let deadline = Instant::now() + TIMEOUT;
    let answer = |id: i64| -> Result<Value> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let v = rx
                .recv_timeout(left)
                .map_err(|_| anyhow!("Muse did not answer within a minute"))?;
            if v["id"].as_i64() == Some(id) {
                return Ok(v);
            }
        }
    };
    let result = (|| -> Result<Option<Value>> {
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"runtrace","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}})
        )?;
        answer(1)?;
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","method":"initialized","params":{}})
        )?;
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":2,"method":"usage/refresh","params":{}})
        )?;
        let v = answer(2)?;
        if let Some(e) = v.get("error") {
            let kind = e["data"]["kind"].as_str().unwrap_or("");
            if kind == "usageRefreshRateLimited" {
                return Ok(None);
            }
            let class = e["data"]["failureKind"]
                .as_str()
                .or(e["message"].as_str())
                .unwrap_or(kind);
            return Ok(Some(
                json!({"windows": [], "unavailable": {"reason": "probeFailed", "message": format!("Muse could not read usage ({class})")}}),
            ));
        }
        Ok(Some(muse_usage(&v["result"])))
    })();
    drop(stdin);
    stop(&mut child);
    result
}

/// Whether T3's own check already reports windows for this harness, so asking again would only repeat it.
fn t3_reports(t3_caches: Option<&Path>, harness: &str) -> bool {
    let Some(dir) = t3_caches else {
        return false;
    };
    std::fs::read_to_string(dir.join(format!("{harness}.json")))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|j| {
            j["usageLimits"]["windows"]
                .as_array()
                .map(|w| !w.is_empty())
        })
        .unwrap_or(false)
}

/// Asks every harness that is due, in parallel, and saves the answers. A harness whose program is not installed, or that
/// T3 already checks, is left out; one that stopped being checkable drops out of the saved answers.
pub fn run_due(s: &Store, t3_caches: Option<&Path>) -> Result<()> {
    let mut saved: serde_json::Map<String, Value> = s
        .setting(CHECKS)
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let now = chrono::Utc::now().timestamp_millis();
    let mut due = vec![];
    for c in &ALL {
        let bin = if t3_reports(t3_caches, c.harness) {
            None
        } else {
            (c.find)()
        };
        let Some(bin) = bin else {
            saved.remove(c.harness);
            continue;
        };
        let last = saved
            .get(c.harness)
            .and_then(|v| v["checked_at"].as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|d| d.timestamp_millis());
        if last.is_none_or(|l| now - l >= EVERY_MS) {
            due.push((c, bin));
        }
    }
    if due.is_empty() {
        s.set(CHECKS, &Value::Object(saved).to_string())?;
        return Ok(());
    }
    let answers: Vec<(&Check, Result<Option<Value>>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = due
            .iter()
            .map(|(c, bin)| (*c, scope.spawn(|| (c.run)(bin))))
            .collect();
        handles
            .into_iter()
            .map(|(c, h)| {
                (
                    c,
                    h.join()
                        .unwrap_or_else(|_| Err(anyhow!("the check crashed"))),
                )
            })
            .collect()
    });
    for (c, answer) in answers {
        let mut v = match answer {
            Ok(Some(v)) => v,
            // Asked to wait: the last answer stands and the next check is due as usual.
            Ok(None) => match saved.get(c.harness) {
                Some(old) => {
                    let mut old = old.clone();
                    old["checked_at"] = json!(now_iso());
                    old
                }
                None => continue,
            },
            Err(e) => {
                json!({"windows": [], "unavailable": {"reason": "probeFailed", "message": e.to_string()}})
            }
        };
        v["harness"] = json!(c.harness);
        v["name"] = json!(c.name);
        v["checked_at"] = json!(now_iso());
        saved.insert(c.harness.to_string(), v);
    }
    s.set(CHECKS, &Value::Object(saved).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_buckets_become_windows_of_what_is_left() {
        let out = json!({"command":{"data":{"groups":[
            {"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.25,"reset_time":"2026-11-19T23:18:02Z"}]},
            {"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-11-20T10:00:00Z"}]}
        ]}}});
        let w = antigravity_usage(&out);
        assert_eq!(w[0]["window"], "seven_day_gemini");
        assert_eq!(w[0]["label"], "Weekly · Gemini");
        assert_eq!(w[0]["used_percentage"], 75.0);
        assert_eq!(w[0]["reset_at"], "2026-11-19T23:18:02Z");
        assert_eq!(w[1]["window"], "seven_day_claude_and_gpt");
        assert_eq!(w[1]["label"], "Weekly · Claude and GPT");
        // Unused, so its reset is not running yet.
        assert!(w[1]["reset_at"].is_null());
    }

    #[test]
    fn muse_without_usage_says_why() {
        let v = muse_usage(&json!({"tierName":"High Usage","subscriptionActive":true}));
        assert_eq!(v["plan"], "High Usage");
        assert_eq!(v["unavailable"]["reason"], "noUsageData");
        let v = muse_usage(&json!({"subscriptionActive":false}));
        assert_eq!(v["unavailable"]["reason"], "noSubscription");
        let v = muse_usage(
            &json!({"usage":{"observedAtMs":1,"tier":"t","window":{"usedPercent":40,"resetsAtMs":1_800_000_000_000_i64,"windowDurationMins":300},"weekly":{"usedPercent":12,"resetsAtMs":1_800_100_000_000_i64}}}),
        );
        assert_eq!(v["windows"][0]["window"], "five_hour");
        assert_eq!(v["windows"][0]["used_percentage"], 40.0);
        assert_eq!(v["windows"][1]["window"], "weekly");
        assert_eq!(v["windows"][1]["window_minutes"], 10_080);
    }
}
