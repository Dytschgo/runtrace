//! What the background collector is doing, as one explicit state. Every change goes through `CollectorStatus::after`,
//! so the last good sync time survives failures and pauses, and the health report always names exactly one state.
//!
//! ```text
//! disabled                       (collect_on_serve = false; never changes)
//! starting ──sync ok──▶ synced | partial | paused
//!    │                    ▲  │
//!    └──sync failed──▶ retrying ◀─┘ (sync failed, or the import task crashed: backoff doubles up to an hour)
//!                         │
//!                         └──no connection left to retry with──▶ failed (final)
//! ```
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectorState {
    Disabled,
    Starting,
    Synced,
    /// The sync finished, but some projects could not be read.
    Partial,
    /// Capture is paused by the user; nothing new is read.
    Paused,
    Retrying,
    /// The collector cannot continue until the service restarts.
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct CollectorStatus {
    pub state: CollectorState,
    /// The last time a sync read the source completely or partly. Kept through failures and pauses, so the dashboard
    /// can say how old its data is exactly when capture is not working.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_successful_sync_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_category: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_seconds: Option<u64>,
}

/// What happened in one round of the collector loop.
pub enum Event {
    Synced {
        report: Value,
        duration_ms: u128,
        at: String,
    },
    SyncFailed {
        retry_seconds: u64,
    },
    TaskCrashed {
        retry_seconds: u64,
    },
    CannotContinue,
}

impl CollectorStatus {
    pub fn initial(collecting: bool) -> Self {
        Self {
            state: if collecting {
                CollectorState::Starting
            } else {
                CollectorState::Disabled
            },
            last_successful_sync_at: None,
            duration_ms: None,
            report: None,
            error_category: None,
            retry_seconds: None,
        }
    }

    /// The state after an event. Only the last sync time and the latest report carry over.
    pub fn after(&self, event: Event) -> Self {
        let carried = Self {
            last_successful_sync_at: self.last_successful_sync_at.clone(),
            ..Self::initial(true)
        };
        match event {
            Event::Synced {
                report,
                duration_ms,
                at,
            } => {
                let paused = report["paused"] == true;
                let state = if paused {
                    CollectorState::Paused
                } else if report["partial_sync"] == true {
                    CollectorState::Partial
                } else {
                    CollectorState::Synced
                };
                Self {
                    state,
                    // A paused round read nothing, so the last sync time stays what it was.
                    last_successful_sync_at: if paused {
                        carried.last_successful_sync_at
                    } else {
                        Some(at)
                    },
                    duration_ms: Some(duration_ms),
                    report: Some(report),
                    ..carried
                }
            }
            Event::SyncFailed { retry_seconds } => Self {
                state: CollectorState::Retrying,
                error_category: Some("source_sync_failed"),
                retry_seconds: Some(retry_seconds),
                ..carried
            },
            Event::TaskCrashed { retry_seconds } => Self {
                state: CollectorState::Retrying,
                error_category: Some("collector_task_failed"),
                retry_seconds: Some(retry_seconds),
                ..carried
            },
            Event::CannotContinue => Self {
                state: CollectorState::Failed,
                error_category: Some("collector_task_failed"),
                ..carried
            },
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn synced(report: Value, at: &str) -> Event {
        Event::Synced {
            report,
            duration_ms: 5,
            at: at.into(),
        }
    }

    #[test]
    fn the_last_sync_time_survives_failures_and_pauses() {
        let s = CollectorStatus::initial(true);
        assert_eq!(s.state, CollectorState::Starting);
        let s = s.after(synced(json!({"changed": 3}), "2026-11-08T10:00:00Z"));
        assert_eq!(s.state, CollectorState::Synced);
        let s = s.after(Event::SyncFailed { retry_seconds: 120 });
        assert_eq!(
            (s.state, s.retry_seconds),
            (CollectorState::Retrying, Some(120))
        );
        assert_eq!(
            s.last_successful_sync_at.as_deref(),
            Some("2026-11-08T10:00:00Z")
        );
        assert!(
            s.report.is_none(),
            "a failed round has no report of its own"
        );
        let s = s.after(synced(json!({"paused": true}), "2026-11-08T11:00:00Z"));
        assert_eq!(s.state, CollectorState::Paused);
        assert_eq!(
            s.last_successful_sync_at.as_deref(),
            Some("2026-11-08T10:00:00Z"),
            "a paused round read nothing"
        );
        let s = s.after(synced(
            json!({"partial_sync": true}),
            "2026-11-08T12:00:00Z",
        ));
        assert_eq!(
            (s.state, s.last_successful_sync_at.as_deref()),
            (CollectorState::Partial, Some("2026-11-08T12:00:00Z"))
        );
        assert!(s.error_category.is_none());
    }

    #[test]
    fn a_crashed_task_retries_and_only_a_lost_connection_is_final() {
        let s = CollectorStatus::initial(true).after(Event::TaskCrashed { retry_seconds: 60 });
        assert_eq!(
            (s.state, s.error_category),
            (CollectorState::Retrying, Some("collector_task_failed"))
        );
        let s = s.after(Event::CannotContinue);
        assert_eq!(s.state, CollectorState::Failed);
    }

    #[test]
    fn the_report_keeps_the_shape_the_dashboard_reads() {
        let s = CollectorStatus::initial(false);
        assert_eq!(s.to_json(), json!({"state": "disabled"}));
        let s = CollectorStatus::initial(true)
            .after(synced(json!({"changed": 0}), "2026-11-08T10:00:00Z"));
        let j = s.to_json();
        assert_eq!(j["state"], "synced");
        assert_eq!(j["last_successful_sync_at"], "2026-11-08T10:00:00Z");
        assert_eq!(j["report"]["changed"], 0);
    }
}
