use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub const MAX_READING_GAP_MS: i64 = 20 * 60_000;

/// Missing observations are explicit. Sleep is attributed only to a recorded
/// Windows power interval overlapping the gap, never inferred from silence.
pub fn reading_gaps(times: &[i64], start: i64, end: i64, sleep: &[Value]) -> Vec<Value> {
    if end <= start {
        return vec![];
    }
    let mut times: Vec<_> = times
        .iter()
        .copied()
        .filter(|t| *t >= start && *t < end)
        .collect();
    times.sort_unstable();
    times.dedup();
    let mut edges = vec![start];
    edges.extend(times);
    edges.push(end);
    edges.windows(2).filter(|p|p[1]-p[0]>MAX_READING_GAP_MS).map(|p| {
        let causes:Vec<_>=sleep.iter().filter_map(|s| {
            let from=s["sleep_epoch_ms"].as_i64()?.max(p[0]);
            let until=s["wake_epoch_ms"].as_i64()?.min(p[1]);
            (until>from && s["source"]=="windows_power_event").then(||json!({"reason":"observer_asleep","start_epoch_ms":from,"end_epoch_ms":until,"source":"windows_power_event"}))
        }).collect();
        json!({"reason":"no_readings","start_epoch_ms":p[0],"end_epoch_ms":p[1],"causes":causes})
    }).collect()
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Sample {
    pub sampled_at: i64,
    pub reset_at: i64,
    pub remaining_percentage: Option<f64>,
    pub valid: bool,
}
#[derive(Serialize)]
pub struct Window {
    pub unused_percentage_before_reset: Option<f64>,
    pub capture_quality: &'static str,
    pub complete: bool,
}
pub fn reset_window(samples: &[Sample], start: i64, reset: i64, max_gap: i64) -> Window {
    let mut s: Vec<_> = samples
        .iter()
        .filter(|s| {
            s.valid
                && s.sampled_at >= start
                && s.sampled_at < reset
                && s.reset_at == reset
                && s.remaining_percentage
                    .is_some_and(|v| (0.0..=100.0).contains(&v))
        })
        .collect();
    s.sort_by_key(|s| s.sampled_at);
    let complete = s.first().is_some_and(|s| s.sampled_at - start <= max_gap)
        && s.last().is_some_and(|s| reset - s.sampled_at <= max_gap)
        && s.windows(2)
            .all(|p| p[1].sampled_at - p[0].sampled_at <= max_gap);
    Window {
        unused_percentage_before_reset: s.last().and_then(|s| s.remaining_percentage),
        capture_quality: if complete {
            "complete"
        } else if s.is_empty() {
            "unavailable"
        } else {
            "partial"
        },
        complete,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gaps_cover_edges_and_only_attribute_recorded_sleep() {
        let m = 60_000;
        let sleep = [
            json!({"sleep_epoch_ms":130*m,"wake_epoch_ms":400*m,"source":"windows_power_event"}),
            json!({"sleep_epoch_ms":0,"wake_epoch_ms":999*m,"source":"guess"}),
        ];
        let gaps = reading_gaps(&[120 * m, 400 * m, 410 * m], 100 * m, 450 * m, &sleep);
        assert_eq!(gaps.len(), 2);
        assert_eq!(gaps[0]["start_epoch_ms"], 120 * m);
        assert_eq!(gaps[0]["causes"].as_array().unwrap().len(), 1);
        assert_eq!(gaps[0]["causes"][0]["start_epoch_ms"], 130 * m);
        assert_eq!(gaps[1]["end_epoch_ms"], 450 * m);
        assert!(gaps[1]["causes"].as_array().unwrap().is_empty());
        assert_eq!(reading_gaps(&[], 0, 60 * m, &[]).len(), 1);
        assert!(reading_gaps(&[0, 20 * m, 40 * m], 0, 60 * m, &[]).is_empty());
    }
    #[test]
    fn final_sample() {
        let s = vec![
            Sample {
                sampled_at: 0,
                reset_at: 100,
                remaining_percentage: Some(70.),
                valid: true,
            },
            Sample {
                sampled_at: 90,
                reset_at: 100,
                remaining_percentage: Some(20.),
                valid: true,
            },
            Sample {
                sampled_at: 101,
                reset_at: 200,
                remaining_percentage: Some(100.),
                valid: true,
            },
        ];
        let w = reset_window(&s, 0, 100, 95);
        assert_eq!(w.unused_percentage_before_reset, Some(20.));
        assert!(w.complete);
        assert!(!reset_window(&s[1..], 0, 100, 10).complete);
    }
    #[test]
    fn missing() {
        assert!(
            reset_window(&[], 0, 100, 10)
                .unused_percentage_before_reset
                .is_none()
        );
    }
}
