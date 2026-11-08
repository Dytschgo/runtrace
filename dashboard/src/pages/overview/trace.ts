import { METRICS, RESOLUTION_MS, type GroupBy, type Metric, type Resolution, type Trace } from '../../lib/series';

/** The Overview chart's choices and how the period before is lined up with this one. */
export const GROUPS: { value: GroupBy; label: string }[] = [{ value: 'model', label: 'Models' }, { value: 'provider', label: 'Providers' }, { value: 'project', label: 'Projects' }];
export const RES_OPTIONS: { value: Resolution | 'auto'; label: string }[] = [{ value: 'auto', label: 'Auto' }, { value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '1d', label: '1d' }, { value: '1w', label: '1w' }];
export const RES_WORDS: Record<Resolution, string> = { '5m': '5 minutes', '15m': '15 minutes', '1h': 'hour', '6h': '6 hours', '1d': 'day', '1w': 'week' };
export const isGroup = (v: string | null): v is GroupBy => v === 'model' || v === 'provider' || v === 'project';
export const isMetric = (v: string | null): v is Metric => METRICS.some((m) => m.key === v);
export const isRes = (v: string | null): v is Resolution => v !== null && Object.hasOwn(RESOLUTION_MS, v);

/** The period before, paired with this one by time. A value left out is null, and one that is only partly known is flagged. */
export function periodBefore(rows: Trace['rows'], before: Trace, offset: number, focus: string | null) {
  const silent = new Set<number>();
  const lower = new Set<number>();
  const values = rows.map((row, here) => {
    const at = row.t - offset;
    const i = before.rows.findIndex((r) => at >= r.t && at < r.end);
    if (i < 0) return null;
    const r = before.rows[i];
    if (focus ? before.silentGroups.get(i)?.has(focus) : before.unreported.has(i) && before.series.every((x) => !r[x.key])) { silent.add(here); return null; }
    if (focus ? before.partials.get(i)?.has(focus) : before.partials.get(i)?.size || before.unreported.has(i)) lower.add(here);
    return focus ? Number(r[focus] ?? 0) : before.series.reduce((s, x) => s + Number(r[x.key] ?? 0), 0);
  });
  return { values, silent, lower };
}
