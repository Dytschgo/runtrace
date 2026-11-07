import { hasTurnUsage } from './entities';
import { fmtDay, localParts, zonedDayStart } from './format';
import type { AgentRow, ThreadRow, ToolRow, TurnRow } from './entities';
import { isKnown } from './format';
import type { HourRow, ModelRow } from './types';

const HOUR = 3_600_000;

export interface Bucket { key: string; iso: string; value: number }
export interface Series { unit: 'hour' | 'day'; points: Bucket[] }

/**
 * Buckets UTC-hour counts in the display timezone: hourly up to two weeks, daily beyond.
 * Filling runs only from first to last observed record, so time before capture began never reads as zero activity.
 */
export function bucketActivity(rows: HourRow[], tz: string, unit?: 'hour' | 'day'): Series {
  if (!rows.length) return { unit: unit ?? 'hour', points: [] };
  const sorted = [...rows].sort((a, b) => a.hour.localeCompare(b.hour));
  const first = Date.parse(sorted[0].hour);
  const last = Date.parse(sorted[sorted.length - 1].hour);
  const byHour = new Map(sorted.map((r) => [Date.parse(r.hour), r.prompts]));
  if (unit !== 'day' && (unit === 'hour' || last - first <= 14 * 24 * HOUR)) {
    const points: Bucket[] = [];
    for (let t = first; t <= last; t += HOUR) {
      const iso = new Date(t).toISOString();
      points.push({ key: iso, iso, value: byHour.get(t) ?? 0 });
    }
    return { unit: 'hour', points };
  }
  const days = new Map<string, Bucket>();
  for (let t = first; t <= last; t += HOUR) {
    const iso = new Date(t).toISOString();
    const { date } = localParts(iso, tz);
    const b = days.get(date) ?? { key: date, iso, value: 0 };
    b.value += byHour.get(t) ?? 0;
    days.set(date, b);
  }
  return { unit: 'day', points: [...days.values()] };
}

export interface Heatmap {
  grid: number[][]; max: number; total: number; activeDays: number; spanDays: number;
  busiestDay: { date: string; iso: string; count: number } | null;
  peakHour: { hour: number; count: number } | null;
}

/** Monday-first weekday × hour-of-day matrix in the display timezone. */
/**
 * Prompts by weekday and hour. Days are counted as calendar dates in the display timezone, from the first prompt to the
 * last, or across the given window when there is one, so active days can never exceed the days counted.
 */
export function buildHeatmap(rows: HourRow[], tz: string, window?: { since?: string; until?: string }): Heatmap {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const dayTotals = new Map<string, { iso: string; count: number }>();
  const hourTotals = Array<number>(24).fill(0);
  let total = 0;
  for (const r of rows) {
    const { date, hour, weekday } = localParts(r.hour, tz);
    if (weekday < 0) continue;
    grid[weekday][hour] += r.prompts;
    hourTotals[hour] += r.prompts;
    total += r.prompts;
    const d = dayTotals.get(date) ?? { iso: r.hour, count: 0 };
    d.count += r.prompts;
    dayTotals.set(date, d);
  }
  let busiestDay: Heatmap['busiestDay'] = null;
  for (const [date, d] of dayTotals) if (!busiestDay || d.count > busiestDay.count) busiestDay = { date, iso: d.iso, count: d.count };
  const maxHour = Math.max(0, ...hourTotals);
  const sorted = rows.map((r) => Date.parse(r.hour)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  const dateNumber = (ms: number) => { const [y, m, d] = localParts(new Date(ms).toISOString(), tz).date.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
  const from = window?.since ? Date.parse(window.since) : sorted[0];
  const to = Math.min(window?.until ? Date.parse(window.until) : sorted[sorted.length - 1] ?? NaN, window ? Date.now() : Infinity);
  const span = Number.isFinite(from) && Number.isFinite(to) && to >= from ? dateNumber(to) - dateNumber(from) + 1 : 0;
  return {
    grid, max: Math.max(0, ...grid.flat()), total, activeDays: dayTotals.size,
    spanDays: sorted.length || window?.since ? Math.max(span, dayTotals.size) : 0,
    busiestDay, peakHour: maxHour > 0 ? { hour: hourTotals.indexOf(maxHour), count: maxHour } : null,
  };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export interface ToolStat {
  name: string; category: string; calls: number; failed: number; statusKnown: number;
  p50: number | null; p95: number | null; max: number | null; timed: number; chars: number;
}

export function toolStats(rows: ToolRow[]): ToolStat[] {
  const groups = new Map<string, ToolRow[]>();
  for (const r of rows) (groups.get(r.name) ?? groups.set(r.name, []).get(r.name)!).push(r);
  return [...groups].map(([name, g]) => {
    const durations = g.flatMap((r) => (r.duration === null ? [] : [r.duration]));
    return {
      name, category: g[0].category, calls: g.length,
      failed: g.filter((r) => r.status === 'failed').length,
      statusKnown: g.filter((r) => r.status !== null).length,
      p50: percentile(durations, 0.5), p95: percentile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null, timed: durations.length,
      chars: g.reduce((sum, r) => sum + (r.chars ?? 0), 0),
    };
  }).sort((a, b) => b.calls - a.calls);
}

export interface ToolSummary {
  calls: number; failed: number; statusKnown: number; shell: number; exitKnown: number; nonZero: number;
  p50: number | null; p95: number | null; timed: number;
}
export function toolSummary(rows: ToolRow[]): ToolSummary {
  const durations = rows.flatMap((r) => (r.duration === null ? [] : [r.duration]));
  const shell = rows.filter((r) => r.category === 'shell');
  return {
    calls: rows.length, failed: rows.filter((r) => r.status === 'failed').length, statusKnown: rows.filter((r) => r.status !== null).length,
    shell: shell.length, exitKnown: shell.filter((r) => r.exit !== null).length, nonZero: shell.filter((r) => r.exit !== null && r.exit !== 0).length,
    p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), timed: durations.length,
  };
}

export interface ToolHeadline extends ToolSummary {
  /** Which parts come only from the loaded calls, because the window holds more than were read. */
  sampled: { calls: boolean; time: boolean; exit: boolean };
}

/**
 * The tool headline from the most complete source there is. When every call was read, the loaded calls
 * are exact. Otherwise the service totals win: the window summary when nothing is filtered, or the
 * per-tool totals for one tool or one category. Anything still taken from the loaded calls is flagged.
 */
export function toolHeadline(loaded: ToolSummary, complete: boolean, opts: {
  full?: ToolSummary | null; stats?: ToolStat[] | null; tool?: string; category?: string; status?: string;
}): ToolHeadline {
  const all = { calls: false, time: false, exit: false };
  const { full, stats, tool, category, status } = opts;
  // With nothing chosen, the service's window totals come first: they refresh with the chart, while the loaded calls are read once.
  if (!tool && !category && !status && full) return { ...full, sampled: all };
  if (complete) return { ...loaded, sampled: all };
  if (!status && stats) {
    const match = tool ? stats.filter((s) => s.name === tool && (!category || s.category === category)) : category ? stats.filter((s) => s.category === category) : [];
    if (match.length === 1 || (match.length && !tool)) {
      const one = match.length === 1 ? match[0] : null;
      return {
        ...loaded,
        calls: match.reduce((n, s) => n + s.calls, 0),
        failed: match.reduce((n, s) => n + s.failed, 0),
        statusKnown: match.reduce((n, s) => n + s.statusKnown, 0),
        p50: one ? one.p50 : loaded.p50, p95: one ? one.p95 : loaded.p95, timed: one ? one.timed : loaded.timed,
        sampled: { calls: false, time: !one, exit: true },
      };
    }
  }
  return { ...loaded, sampled: { calls: true, time: true, exit: true } };
}

export type DayStack ={ day: string; label: string; iso: string; [series: string]: string | number };

const nextDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** Per-local-day counts of one row property, as flat rows ready for a stacked chart. Empty days stay on the axis so spacing is true to time. */
export function stackByDay<T>(rows: T[], when: (r: T) => string, series: (r: T) => string, tz: string, weight: (r: T) => number = () => 1): DayStack[] {
  const days = new Map<string, DayStack>();
  for (const r of rows) {
    const iso = when(r);
    if (Number.isNaN(Date.parse(iso))) continue;
    const { date } = localParts(iso, tz);
    const row: DayStack = days.get(date) ?? { day: date, label: fmtDay(iso, tz), iso };
    const key = series(r);
    row[key] = ((row[key] as number | undefined) ?? 0) + weight(r);
    days.set(date, row);
  }
  const sorted = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const filled: DayStack[] = [];
  for (const row of sorted) {
    let prev = filled[filled.length - 1]?.day;
    while (prev && nextDate(prev) < row.day) {
      prev = nextDate(prev);
      const iso = new Date(zonedDayStart(prev, tz).getTime() + 12 * HOUR).toISOString();
      filled.push({ day: prev, label: fmtDay(iso, tz), iso });
    }
    filled.push(row);
  }
  return filled;
}

export interface Coverage { id: string; entity: string; field: string; known: number; total: number; note: string }

export interface TokenSummary {
  total: number | null; input: number | null; cached: number | null; output: number | null; reasoning: number | null;
  cacheWrite?: number | null; cacheWriteTurns?: number | null;
  /** Fields some turns left out, where the sum is a lower bound. Without this, only the overall coverage is known. */
  short?: Partial<Record<'input' | 'cached' | 'cacheWrite' | 'output' | 'reasoning', boolean>>;
  turns: number | null; withUsage: number | null; complete: number | null; noUsage: string[];
}

const sumKnown = (values: (number | null | undefined)[]) => {
  const known = values.filter(isKnown);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/** Adds up only what providers reported. All-null stays null, and models whose turns reported nothing are named. */
export function tokenSummary(rows: ModelRow[]): TokenSummary {
  return {
    total: sumKnown(rows.map((r) => r.total_tokens)), input: sumKnown(rows.map((r) => r.input_tokens)), cached: sumKnown(rows.map((r) => r.cached_input_tokens)),
    cacheWrite: sumKnown(rows.map((r) => r.cache_write_tokens)), cacheWriteTurns: sumKnown(rows.map((r) => r.cache_write_observed_turns)),
    output: sumKnown(rows.map((r) => r.output_tokens)), reasoning: sumKnown(rows.map((r) => r.reasoning_tokens)),
    turns: sumKnown(rows.map((r) => r.observed_provider_turns)), withUsage: sumKnown(rows.map((r) => r.turns_with_usage)), complete: sumKnown(rows.map((r) => r.complete_usage_turns)),
    noUsage: rows.filter((r) => r.model && (r.observed_provider_turns ?? 0) > 0 && !r.turns_with_usage).map((r) => r.model as string),
  };
}

/** Long stretches with no record at all, which mean nothing was captured rather than that nothing ran. */
export function captureGaps(hours: string[], longest = 10 * 86_400_000): [number, number][] {
  const times = hours.map((h) => Date.parse(h)).filter(Number.isFinite).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] >= longest) out.push([times[i - 1] + 3_600_000, times[i]]);
  return out;
}

/** The same summary from single turns, for a selection the API cannot total by itself. */
export function summaryFromTurns(turns: { total: number | null; input: number | null; cached: number | null; cacheWrite?: number | null; output: number | null; reasoning: number | null }[]): TokenSummary {
  return {
    total: sumKnown(turns.map((t) => t.total)), input: sumKnown(turns.map((t) => t.input)), cached: sumKnown(turns.map((t) => t.cached)),
    cacheWrite: sumKnown(turns.map((t) => t.cacheWrite)), cacheWriteTurns: turns.filter((t) => typeof t.cacheWrite === 'number').length,
    output: sumKnown(turns.map((t) => t.output)), reasoning: sumKnown(turns.map((t) => t.reasoning)),
    turns: turns.length, withUsage: turns.filter((t) => [t.total, t.input, t.cached, t.output, t.reasoning].some((v) => typeof v === 'number')).length, complete: turns.filter((t) => t.total !== null).length,
    noUsage: [],
    short: {
      input: turns.some((t) => t.input === null), cached: turns.some((t) => t.cached === null), cacheWrite: turns.some((t) => typeof t.cacheWrite !== 'number'),
      output: turns.some((t) => t.output === null), reasoning: turns.some((t) => t.reasoning === null),
    },
  };
}

/** `withTotal` counts turns that reported a total. Fewer than `turns` makes the sum a lower bound. */
export interface ThreadTokens { total: number | null; turns: number; withUsage: number; withTotal?: number }

export function tokensByKey<T>(turns: T[], key: (t: T) => string, total: (t: T) => number | null, hasUsage?: (t: T) => boolean): Map<string, ThreadTokens> {
  const m = new Map<string, ThreadTokens>();
  for (const t of turns) {
    const k = key(t);
    const cur = m.get(k) ?? { total: null, turns: 0, withUsage: 0 };
    const v = total(t);
    cur.turns += 1;
    if (v !== null) cur.total = (cur.total ?? 0) + v;
    if (hasUsage ? hasUsage(t) : v !== null) cur.withUsage += 1;
    m.set(k, cur);
  }
  return m;
}

export interface ProviderUsage { provider: string; turns: number; complete: number; partial: number; unavailable: number; total: number | null }

export function usageByProvider(turns: TurnRow[]): ProviderUsage[] {
  const m = new Map<string, ProviderUsage>();
  for (const t of turns) {
    const name = t.provider ?? 'Not recorded';
    const p = m.get(name) ?? { provider: name, turns: 0, complete: 0, partial: 0, unavailable: 0, total: null };
    p.turns += 1;
    if (t.usage === 'complete') p.complete += 1;
    else if (t.usage === 'partial') p.partial += 1;
    else p.unavailable += 1;
    if (t.total !== null) p.total = (p.total ?? 0) + t.total;
    m.set(name, p);
  }
  return [...m.values()].sort((a, b) => b.turns - a.turns);
}

export function coverageRows(threads: ThreadRow[], agents: AgentRow[], tools: ToolRow[], turns: TurnRow[] = []): Coverage[] {
  const count = <T,>(rows: T[], f: (r: T) => boolean) => rows.filter(f).length;
  const shell = tools.filter((t) => t.category === 'shell');
  return [
    { id: 'thread-lineage', entity: 'Threads', field: 'Lineage resolved', known: count(threads, (t) => t.resolved === true), total: threads.length, note: 'Parent links followed to a root without a break or cycle.' },
    { id: 'thread-model', entity: 'Threads', field: 'Model selection', known: count(threads, (t) => t.model !== null), total: threads.length, note: 'Requested model. The resolved model is not captured.' },
    { id: 'turn-usage', entity: 'Provider turns', field: 'Token usage reported', known: count(turns, hasTurnUsage), total: turns.length, note: 'At least one token field is recorded for the main-agent provider turn, including partial usage.' },
    { id: 'turn-complete', entity: 'Provider turns', field: 'Usage complete', known: count(turns, (t) => t.usage === 'complete'), total: turns.length, note: 'Some providers report only part of the usage breakdown.' },
    { id: 'turn-model', entity: 'Provider turns', field: 'Model', known: count(turns, (t) => t.model !== null), total: turns.length, note: 'Requested model for the turn.' },
    { id: 'turn-resolved', entity: 'Provider turns', field: 'Resolved model', known: count(turns, (t) => t.resolved !== null), total: turns.length, note: 'The model the provider actually served.' },
    { id: 'turn-latency', entity: 'Provider turns', field: 'Latency', known: count(turns, (t) => t.duration !== null), total: turns.length, note: 'Duration of the whole turn. Individual model calls are not captured.' },
    { id: 'agent-child', entity: 'Agents', field: 'Child thread link', known: count(agents, (a) => a.child !== null), total: agents.length, note: 'The explicit child_thread_id that Agent Trees draws as an edge.' },
    { id: 'agent-end', entity: 'Agents', field: 'Completion time', known: count(agents, (a) => a.completed !== null), total: agents.length, note: 'Needed for a sub-agent duration.' },
    { id: 'agent-return', entity: 'Agents', field: 'Result delivery state', known: count(agents, (a) => a.returned !== null), total: agents.length, note: 'Only explicit delivery records count. Missing means not recorded, not failed.' },
    { id: 'tool-duration', entity: 'Tool calls', field: 'Duration', known: count(tools, (t) => t.duration !== null), total: tools.length, note: 'Derived from started and completed times.' },
    { id: 'tool-status', entity: 'Tool calls', field: 'Status', known: count(tools, (t) => t.status !== null), total: tools.length, note: 'Source projection status.' },
    { id: 'tool-category', entity: 'Tool calls', field: 'Category', known: count(tools, (t) => t.category !== 'unknown'), total: tools.length, note: 'Only built-in item types are classified. MCP and provider tools stay uncategorised.' },
    { id: 'tool-exit', entity: 'Shell calls', field: 'Exit code', known: count(shell, (t) => t.exit !== null), total: shell.length, note: 'Applies to shell commands only.' },
  ];
}

export function redactionTotals(rows: { categories: string[] }[]): { category: string; records: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) for (const c of new Set(r.categories)) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m].map(([category, records]) => ({ category, records })).sort((a, b) => b.records - a.records);
}

export function delta(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

export interface WindowTokens {
  /** Tokens per thread from turns inside the window, the same turns the Overview adds up. */
  byThread: Map<string, ThreadTokens>;
  /** Everything in the window, session-log hours included, so it matches the Overview headline. Null when nothing reported. */
  total: number | null;
  /** Session-log hours: tokens an agent logged, not tied to any one thread. */
  logTotal: number | null;
  /** Provider turns with no thread recorded. */
  unthreaded: number | null;
  /** Provider turns in the window and how many reported a total; fewer reported makes the total a lower bound. */
  turns: number; reported: number;
}

/** Token totals for a window, split by thread, with the parts no thread can claim kept apart rather than dropped. */
export function windowTokens(turns: TurnRow[], f: { since?: string; until?: string; model?: string }): WindowTokens {
  const since = f.since ? Date.parse(f.since) : -Infinity;
  const until = f.until ? Date.parse(f.until) : Infinity;
  const add = (a: number | null, v: number | null) => (v === null ? a : (a ?? 0) + v);
  const byThread = new Map<string, ThreadTokens>();
  let total: number | null = null, logTotal: number | null = null, unthreaded: number | null = null, turnCount = 0, reported = 0;
  for (const t of turns) {
    const ms = Date.parse(t.occurred_at);
    if (!(ms >= since && ms <= until) || (f.model && t.model !== f.model)) continue;
    total = add(total, t.total);
    if (t.log) { logTotal = add(logTotal, t.total); continue; }
    turnCount += 1;
    if (t.total !== null) reported += 1;
    if (!t.thread_id) { unthreaded = add(unthreaded, t.total); continue; }
    const cur = byThread.get(t.thread_id) ?? { total: null, turns: 0, withUsage: 0, withTotal: 0 };
    cur.turns += 1;
    if (t.total !== null) cur.withTotal = (cur.withTotal ?? 0) + 1;
    cur.total = add(cur.total, t.total);
    if (hasTurnUsage(t)) cur.withUsage += 1;
    byThread.set(t.thread_id, cur);
  }
  return { byThread, total, logTotal, unthreaded, turns: turnCount, reported };
}
