// Read-only holdout check of the exact dashboard pace function on a past window.
// Prints quota numbers/times only; no account, project or conversation data.
import { quotaPace, leftOf } from '../src/lib/quota.ts';

const base = process.argv[2] ?? 'http://127.0.0.1:4310';
async function read(route) {
  const response = await fetch(new URL('/api/v1/' + route, base));
  if (!response.ok) throw new Error(`Quota read failed: ${response.status}`);
  return (await response.json()).data ?? [];
}
const [windows, samples] = await Promise.all([read('quota/windows'), read('quota/samples')]);
const ordered = windows.filter((w) => w.ended !== false && Date.parse(w.reset_at) <= Date.now() && w.window_minutes > 0)
  .sort((a, b) => Date.parse(b.reset_at) - Date.parse(a.reset_at) || String(a.provider).localeCompare(String(b.provider)) || String(a.window).localeCompare(String(b.window)));
const checks = [];
let skipped = 0;
for (const w of ordered) {
  const resetAt = Date.parse(w.reset_at);
  const start = resetAt - w.window_minutes * 60_000;
  const own = samples.filter((s) => s.provider === w.provider && s.window === w.window && s.reset_at === w.reset_at)
    .map((s) => ({ at: Date.parse(s.sampled_at), used: s.used_percentage, resetAt }))
    .filter((s) => Number.isFinite(s.at) && Number.isFinite(s.used) && s.at >= start && s.at < resetAt)
    .sort((a, b) => a.at - b.at);
  const cutoff = own.length ? own[0].at + (own.at(-1).at - own[0].at) / 2 : NaN;
  const training = own.filter((s) => s.at <= cutoff);
  const last = training.at(-1);
  const target = own.at(-1);
  const pace = last ? quotaPace(training, w.window_minutes, resetAt, last.at) : null;
  if (!pace || !target || target.at <= last.at) { skipped++; continue; }
  const usedAtCutoff = Math.max(...training.map((s) => s.used));
  const predictedLeft = leftOf(usedAtCutoff + pace.perHour * (target.at - last.at) / 3_600_000);
  const actualLeft = leftOf(target.used);
  const checked = {
    selection: checks.length ? 'Latest eligible ended window with positive recent pace; no selection by forecast error' : 'Latest ended window with an eligible midpoint training span and later reading; no selection by forecast error',
    provider: w.provider, window: w.window, reset_at: w.reset_at,
    coverage: w.capture_quality, earlier_ineligible_windows: skipped,
    training_readings: training.length, holdout_readings: own.length - training.length,
    forecast_at: new Date(last.at).toISOString(), observed_at: new Date(target.at).toISOString(),
    horizon_minutes: (target.at - last.at) / 60_000,
    projection_basis_minutes: pace.basisMs / 60_000, projected_use_points_per_hour: pace.perHour,
    predicted_remaining_percentage: predictedLeft, observed_remaining_percentage: actualLeft,
    absolute_error_percentage_points: Math.abs(predictedLeft - actualLeft),
    projected_exhaustion_at: pace.fullAt === null ? null : new Date(pace.fullAt).toISOString(),
    target: 'Held-out real reading, not an assertion about unobserved use at reset',
  };
  if (!checks.length || (pace.perHour > 0 && checks.every((c) => c.projected_use_points_per_hour === 0))) checks.push(checked);
  if (checks.some((c) => c.projected_use_points_per_hour > 0)) break;
}
if (!checks.length) throw new Error('No ended window has enough readings for an honest holdout check');
console.log(JSON.stringify({ checks, nonzero_pace_checked: checks.some((c) => c.projected_use_points_per_hour > 0) }, null, 2));
