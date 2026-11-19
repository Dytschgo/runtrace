//! Durable at-most-once claims precede delivery to an external notification API.
use crate::storage::{Store, parse_time};
use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize)]
pub struct Alert {
    pub provider: String,
    pub window: String,
    pub reset_at: String,
    pub remaining_percentage: f64,
    pub threshold: u8,
}

/// The caller supplies current readings and a native sink. Claims are committed
/// before the side effect, so a crash or restart cannot repeat a window warning.
/// A crash after claiming but before display can lose a warning; the claim state
/// remains inspectable instead of silently promising exactly-once OS delivery.
pub fn dispatch(
    s: &Store,
    enabled: bool,
    now_ms: i64,
    readings: &[Value],
    mut deliver: impl FnMut(&Alert) -> Result<()>,
) -> Result<Value> {
    if !enabled {
        return Ok(json!({"state":"disabled","shown":0,"failed":0}));
    }
    let mut shown = 0;
    let mut failed = 0;
    for row in readings {
        let Some((provider, window, reset, sampled, used)) = (|| {
            Some((
                row["provider"].as_str()?,
                row["window"].as_str()?,
                row["reset_at"].as_str()?,
                row["sampled_at"].as_str()?,
                row["used_percentage"].as_f64()?,
            ))
        })() else {
            continue;
        };
        let Some(reset_ms) = parse_time(reset).map(|t| t.timestamp_millis()) else {
            continue;
        };
        let Some(sampled_ms) = parse_time(sampled).map(|t| t.timestamp_millis()) else {
            continue;
        };
        if reset_ms <= now_ms
            || sampled_ms > now_ms + 5 * 60_000
            || now_ms - sampled_ms > 20 * 60_000
            || !used.is_finite()
            || used < 0.0
        {
            continue;
        }
        let remaining = (100.0 - used).clamp(0.0, 100.0);
        for threshold in [20u8, 5] {
            if remaining > f64::from(threshold) {
                continue;
            }
            // Structured encoding prevents ambiguous provider/window concatenation.
            let identity = serde_json::to_vec(&(provider, window, reset_ms, threshold))?;
            let key = format!(
                "quota:notification:{}",
                hex::encode(Sha256::digest(identity))
            );
            let alert = Alert {
                provider: provider.into(),
                window: window.into(),
                reset_at: reset.into(),
                remaining_percentage: remaining,
                threshold,
            };
            let mut entry = json!({"state":"claimed","claimed_epoch_ms":now_ms,"alert":alert});
            if s.conn.execute(
                "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING",
                [key.as_str(), entry.to_string().as_str()],
            )? == 0
            {
                if s.setting(&key)
                    .and_then(|v| serde_json::from_str::<Value>(&v).ok())
                    .is_some_and(|v| v["state"] != "shown")
                {
                    failed += 1;
                }
                continue;
            }
            match deliver(&alert) {
                Ok(()) => {
                    entry["state"] = json!("shown");
                    shown += 1;
                }
                Err(_) => {
                    entry["state"] = json!("failed");
                    entry["error_category"] = json!("native_notification_failed");
                    failed += 1;
                }
            }
            s.set(&key, &entry.to_string())?;
        }
    }
    Ok(json!({"state":if failed>0 {"failed"} else {"ready"},"shown":shown,"failed":failed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(tmp: &tempfile::TempDir) -> crate::config::Config {
        let mut c: crate::config::Config =
            toml::from_str(include_str!("../../../config/default.toml")).unwrap();
        c.storage.duckdb_path = tmp.path().join("test.duckdb").to_string_lossy().into();
        c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
        c
    }
    fn row(used: f64) -> Value {
        json!({"provider":"synthetic","window":"five_hour","used_percentage":used,"sampled_at":"2026-11-17T12:00:00Z","reset_at":"2026-11-17T15:00:00Z"})
    }
    #[test]
    fn each_threshold_is_claimed_once_and_survives_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let c = config(&tmp);
        let at = parse_time("2026-11-17T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let s = Store::open(&c).unwrap();
        let mut thresholds = vec![];
        dispatch(&s, true, at, &[row(79.9)], |a| {
            thresholds.push(a.threshold);
            Ok(())
        })
        .unwrap();
        assert!(thresholds.is_empty());
        dispatch(&s, true, at, &[row(80.)], |a| {
            thresholds.push(a.threshold);
            Ok(())
        })
        .unwrap();
        assert_eq!(thresholds, [20]);
        drop(s);
        let s = Store::open(&c).unwrap();
        dispatch(&s, true, at, &[row(80.), row(95.), row(99.)], |a| {
            thresholds.push(a.threshold);
            Ok(())
        })
        .unwrap();
        assert_eq!(thresholds, [20, 5]);
        drop(s);
        let s = Store::open(&c).unwrap();
        dispatch(&s, true, at, &[row(99.)], |_| {
            panic!("restart repeated a warning")
        })
        .unwrap();
        let mut next = row(95.);
        next["reset_at"] = json!("2026-11-17T16:00:00Z");
        assert_eq!(
            dispatch(&s, true, at, &[next], |_| Ok(())).unwrap()["shown"],
            2
        );
    }
    #[test]
    fn disabled_stale_expired_invalid_and_failed_delivery_are_honest() {
        let tmp = tempfile::tempdir().unwrap();
        let c = config(&tmp);
        let s = Store::open(&c).unwrap();
        let at = parse_time("2026-11-17T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            dispatch(&s, false, at, &[row(95.)], |_| panic!("disabled warning")).unwrap()["state"],
            "disabled"
        );
        assert_eq!(
            s.conn
                .query_row(
                    "SELECT count(*) FROM settings WHERE key LIKE 'quota:notification:%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        for now in [at + 21 * 60_000, at + 4 * 60 * 60_000, at - 6 * 60_000] {
            dispatch(&s, true, now, &[row(95.)], |_| panic!("invalid freshness")).unwrap();
        }
        dispatch(&s, true, at, &[row(-1.)], |_| panic!("invalid value")).unwrap();
        let failed = dispatch(&s, true, at, &[row(95.)], |_| {
            anyhow::bail!("synthetic sink failure")
        })
        .unwrap();
        assert_eq!(failed["failed"], 2);
        let repeated = dispatch(&s, true, at, &[row(95.)], |_| {
            panic!("failed claim must not repeat")
        })
        .unwrap();
        assert_eq!(repeated["state"], "failed");
        assert_eq!(repeated["failed"], 2);
    }
}
