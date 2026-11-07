use serde::{Deserialize, Serialize};
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
