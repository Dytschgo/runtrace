import { turnMs, type TurnRow } from './entities';
import { localParts, zonedDayStart, type LocalParts } from './format';
import { FAMILIES, modelProvider, OTHER_COLOR, type Provider } from './modelColors';
import { nextDay } from './timeWindow';

export type GroupBy = 'model' | 'provider' | 'project';
export type Metric = 'total' | 'input' | 'cached' | 'cacheWrite' | 'output' | 'reasoning' | 'turns';
export type Resolution = '5m' | '15m' | '1h' | '6h' | '1d' | '1w';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const RESOLUTION_MS: Record<Resolution, number> = { '5m': 5 * MIN, '15m': 15 * MIN, '1h': HOUR, '6h': 6 * HOUR, '1d': DAY, '1w': 7 * DAY };
const ORDER: Resolution[] = ['5m', '15m', '1h', '6h', '1d', '1w'];

export const METRICS: { key: Metric; label: string; unit: string }[] = [
  { key: 'total', label: 'All tokens', unit: 'tokens' },
  { key: 'input', label: 'Uncached input', unit: 'uncached input tokens' },
  { key: 'cached', label: 'Cache read', unit: 'cache read tokens' },
  { key: 'cacheWrite', label: 'Cache write', unit: 'cache write tokens' },
  { key: 'output', label: 'Output', unit: 'output tokens' },
  { key: 'reasoning', label: 'Reasoning', unit: 'reasoning tokens' },
  { key: 'turns', label: 'Provider turns', unit: 'provider turns' },
];

/** Cache reads and writes sit inside input, so "uncached" is what remains. A field a provider did not report stays null, never zero. */
export function metricValue(t: TurnRow, metric: Metric): number | null {
  switch (metric) {
    case 'total': return t.total;
    case 'input': return t.input === null ? null : Math.max(0, t.input - (t.cached ?? 0) - (t.cacheWrite ?? 0));
    case 'cached': return t.cached;
    case 'cacheWrite': return t.cacheWrite ?? null;
    case 'output': return t.output;
    case 'reasoning': return t.reasoning;
    case 'turns': return t.log ? 0 : 1;
  }
}

/** The finest bars that still read at this span. */
export function autoResolution(spanMs: number): Resolution {
  if (spanMs <= 2 * HOUR) return '5m';
  if (spanMs <= 8 * HOUR) return '15m';
  if (spanMs <= 3 * DAY) return '1h';
  if (spanMs <= 14 * DAY) return '6h';
  if (spanMs <= 120 * DAY) return '1d';
  return '1w';
}

const MAX_BUCKETS = 500;
/** A requested resolution steps up when it would draw more points than a chart can show. */
export function effectiveResolution(requested: Resolution | 'auto', spanMs: number): Resolution {
  let res = requested === 'auto' ? autoResolution(spanMs) : requested;
  while (spanMs / RESOLUTION_MS[res] > MAX_BUCKETS && res !== '1w') res = ORDER[ORDER.indexOf(res) + 1];
  return res;
}

const PROVIDER_DRIVERS: Record<string, Provider> = { codex: 'openai', claudeAgent: 'anthropic', claude: 'anthropic', grok: 'xai', muse: 'meta', gemini: 'google', antigravity: 'google' };
export const PROVIDER_NAMES: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', meta: 'Meta', google: 'Google', qwen: 'Qwen', other: 'Other' };

/** The model name decides when it is recorded. Otherwise the agent that ran the turn does, so a turn with no recorded model still has an owner. */
export function turnProvider(t: Pick<TurnRow, 'model' | 'provider'>): Provider | null {
  if (t.model) return modelProvider(t.model);
  return t.provider ? PROVIDER_DRIVERS[t.provider] ?? 'other' : null;
}

export interface GroupInfo { key: string; label: string; color: string; model: string | null; provider: Provider | null; dash?: boolean; dashArray?: string }

/** Projects have no company colour, so they take a fixed order that avoids white, orange, blue and green. */
const PROJECT_COLORS = ['#e8c547', '#c678dd', '#e06c9f', '#2dd4bf', '#b5d334', '#ff8fa3', '#a89bf2', '#cdb89a', '#f2d98b', '#e3b5f0', '#f0a8c8', '#8fe8d8', '#d8ea85', '#ffc2cd', '#cfc8f8', '#9c8467'];

const PROJECT_DASHES = ['7 4', '2 3', '10 3 2 3'];

/** A project's colour comes from its id alone, so nothing that happens elsewhere, in any window, filter, import or load order, can change it. */
export function projectColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

export interface TraceInput {
  turns: TurnRow[]; by: GroupBy; metric: Metric; res: Resolution; tz: string; since: number; until: number;
  modelColors: Map<string, string>; projectName: (id: string) => string | null; limit?: number; cumulative?: boolean;
  /** Only the group totals, for a list that does not need the rows drawn. */
  totalsOnly?: boolean;
}
export interface TraceRow { t: number; end: number; label: string; tick: string; [series: string]: number | string }
export interface LineTotal { key: string; value: number; turns: number; reported: number; partial: boolean; info: GroupInfo }
export interface Trace {
  rows: TraceRow[]; series: GroupInfo[]; lines: LineTotal[]; total: number | null; reported: number; turns: number;
  /** Everything in the window, turns and session-log hours alike. */
  records: number;
  /** Per row: drawn lines that ran there but reported nothing for this measure. Missing, which is not the same as zero. */
  gaps: Map<number, Set<string>>;
  /** Per row: drawn lines where some turns reported and some did not, so the value is a lower bound. */
  partials: Map<number, Set<string>>;
  /** Per row: the name of every group that ran there and reported nothing, drawn or not. */
  unreported: Map<number, string[]>;
  /** Per row: the same groups by key, so a comparison can tell one group's silence from its zero. */
  silentGroups: Map<number, Set<string>>;
}

const hasAnyTokens = (t: TurnRow) => [t.total, t.input, t.cached, t.cacheWrite, t.output, t.reasoning].some((v) => typeof v === 'number');

const groupOf = (t: TurnRow, by: GroupBy, modelColors: Map<string, string>, projectName: TraceInput['projectName']): GroupInfo => {
  if (by === 'model') {
    if (!t.model) return { key: 'not-recorded', label: 'Not recorded', color: OTHER_COLOR, model: null, provider: turnProvider(t), dash: true };
    return { key: t.model, label: t.model, color: modelColors.get(t.model) ?? OTHER_COLOR, model: t.model, provider: modelProvider(t.model) };
  }
  if (by === 'provider') {
    const p = turnProvider(t);
    return p ? { key: p, label: PROVIDER_NAMES[p], color: FAMILIES[p][0], model: null, provider: p } : { key: 'not-recorded', label: 'Not recorded', color: OTHER_COLOR, model: null, provider: null, dash: true };
  }
  const name = projectName(t.project_id);
  return { key: t.project_id || 'none', label: name ?? 'Project not imported', color: OTHER_COLOR, model: null, provider: null };
};

/** The key a turn is grouped under, without building the rest of its group. */
export const turnGroupKey = (t: TurnRow, by: GroupBy) => (by === 'model' ? t.model || 'not-recorded' : by === 'provider' ? turnProvider(t) ?? 'not-recorded' : t.project_id || 'none');

/** A group that did not run in this window, so it can still be listed and chosen. */
export function idleGroup(by: GroupBy, key: string, modelColors: Map<string, string>): GroupInfo | null {
  if (by === 'model') return { key, label: key, color: modelColors.get(key) ?? OTHER_COLOR, model: key, provider: modelProvider(key) };
  if (by === 'provider' && key in PROVIDER_NAMES) return { key, label: PROVIDER_NAMES[key as Provider], color: FAMILIES[key as Provider][0], model: null, provider: key as Provider };
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local dates per 15 minutes and local midnights per day, for each timezone. A clock change happens on such a boundary, so a 15-minute slot has one offset. */
const zoneCaches = new Map<string, { parts: Map<number, LocalParts>; days: Map<string, number> }>();
function zoneCache(tz: string) {
  let c = zoneCaches.get(tz);
  // Bounded: a few years of slots, then it starts over.
  if (!c || c.parts.size > 200_000) { c = { parts: new Map(), days: new Map() }; zoneCaches.set(tz, c); }
  return c;
}
const labelFormats = new Map<string, Intl.DateTimeFormat>();
function labelFormat(tz: string, sub: boolean) {
  const key = `${tz}|${sub}`;
  let f = labelFormats.get(key);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', ...(sub ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}) }); labelFormats.set(key, f); }
  return f;
}

/**
 * Turns as chart rows and list totals for one window. Empty buckets stay on the axis so spacing is true to time,
 * and a metric no turn reported totals null rather than zero.
 */
export function buildTrace({ turns, by, metric, res, tz, since, until, modelColors, projectName, limit = 8, cumulative, totalsOnly }: TraceInput): Trace {
  // Local dates are kept between calls, because dragging the slider rebuilds the trace on every move over the same turns.
  const cache = zoneCache(tz);
  const hourDate = cache.parts;
  const partsAt = (ms: number) => {
    const key = Math.floor(ms / (15 * MIN));
    let p = hourDate.get(key);
    if (!p) { p = localParts(new Date(ms), tz); hourDate.set(key, p); }
    return p;
  };
  const dayStart = cache.days;
  const startOfDay = (date: string) => {
    let v = dayStart.get(date);
    if (v === undefined) { v = zonedDayStart(date, tz).getTime(); dayStart.set(date, v); }
    return v;
  };
  const size = RESOLUTION_MS[res];
  const floor = (ms: number) => {
    const { date, weekday } = partsAt(ms);
    const day = startOfDay(date);
    if (res === '1d') return day;
    // Walks the calendar rather than counting 24-hour days, so a clock change midweek cannot move the week.
    if (res === '1w') return startOfDay(new Date(Date.parse(`${date}T12:00:00Z`) - (weekday < 0 ? 0 : weekday) * DAY).toISOString().slice(0, 10));
    // Sub-day buckets count elapsed time from local midnight, so 6h means 00, 06, 12 and 18 on the clock, except on a day the clock itself changes.
    return day + Math.floor((ms - day) / size) * size;
  };
  const next = (start: number) => {
    const date = partsAt(start + (res === '1d' || res === '1w' ? HOUR : 0)).date;
    if (res !== '1d' && res !== '1w') {
      // Stays on the same local clock as floor(), so a day with a clock change ends where it really ends and no turn falls between rows.
      const dayEnd = startOfDay(nextDay(date));
      return Math.min(start + size, dayEnd);
    }
    if (res === '1d') return startOfDay(nextDay(date));
    let d = date;
    for (let i = 0; i < 7; i++) d = nextDay(d);
    return startOfDay(d);
  };

  const inWindow = turns.filter((t) => { const ms = turnMs(t); return ms >= since && ms <= until; });

  // Totals decide which groups earn a line, and the rest share one.
  const infos = new Map<string, GroupInfo>();
  const totals = new Map<string, { value: number; turns: number; reported: number; partial: boolean }>();
  // Whether anything in the window reported this measure, session-log hours included, so a total of them is known.
  let measuredAny = false;
  for (const t of inWindow) {
    // A group is described once, from its first turn. Every later turn only needs its key.
    const key = turnGroupKey(t, by);
    if (!infos.has(key)) infos.set(key, groupOf(t, by, modelColors, projectName));
    const entry = totals.get(key) ?? { value: 0, turns: 0, reported: 0, partial: false };
    const v = metricValue(t, metric);
    // An hour read from a session log adds its tokens, but it is not a turn, so it never counts as one.
    if (!t.log) entry.turns += 1;
    if (v !== null) { entry.value += v; measuredAny = true; if (!t.log) entry.reported += 1; }
    if (hasAnyTokens(t)) entry.partial = true;
    totals.set(key, entry);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].value - a[1].value || b[1].turns - a[1].turns);
  if (by === 'project') {
    // A project's colour never changes. There are more projects than colours, so when two on one chart share a colour the later id is dashed, and the colour stays.
    ranked.forEach(([key]) => infos.set(key, { ...infos.get(key)!, color: projectColor(key) }));
    const used = new Map<string, number>();
    ranked.filter(([, e]) => e.value > 0).slice(0, limit).map(([key]) => key).sort().forEach((key) => {
      const info = infos.get(key)!;
      const seen = used.get(info.color) ?? 0;
      used.set(info.color, seen + 1);
      if (seen) infos.set(key, { ...info, dashArray: PROJECT_DASHES[(seen - 1) % PROJECT_DASHES.length] });
    });
  }
  if (by === 'model') {
    // Shades repeat once a provider has more models than its scale. Two drawn models sharing one are told apart by a dash on the one ranked later of all time, so it never changes with the window.
    const order = [...modelColors.keys()];
    const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
    const used = new Map<string, number>();
    ranked.filter(([, e]) => e.value > 0).slice(0, limit).map(([key]) => key).sort((x, y) => rank(x) - rank(y)).forEach((key) => {
      const info = infos.get(key)!;
      if (!info.model) return;
      const seen = used.get(info.color) ?? 0;
      used.set(info.color, seen + 1);
      if (seen) infos.set(key, { ...info, dashArray: PROJECT_DASHES[(seen - 1) % PROJECT_DASHES.length] });
    });
  }
  if (totalsOnly) {
    const lines = ranked.map(([key, e]) => ({ key, value: e.value, turns: e.turns, reported: e.reported, partial: e.partial, info: infos.get(key)! }));
    const reported = lines.reduce((s, l) => s + l.reported, 0);
    return { rows: [], series: [], lines, total: measuredAny ? lines.reduce((s, l) => s + l.value, 0) : null, reported, turns: inWindow.filter((t) => !t.log).length, records: inWindow.length, gaps: new Map(), partials: new Map(), unreported: new Map(), silentGroups: new Map() };
  }
  const drawn = ranked.filter(([, e]) => e.value > 0).slice(0, limit).map(([key]) => key);
  const drawnSet = new Set(drawn);
  const hasRest = ranked.some(([key, e]) => !drawnSet.has(key) && e.value > 0);
  const OTHER: GroupInfo = { key: 'Other', label: 'Other', color: OTHER_COLOR, model: null, provider: null, dash: true };

  const sub = res !== '1d' && res !== '1w';
  const labels = labelFormat(tz, sub);
  const fmtLabel = (ms: number) => labels.format(new Date(ms));
  const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
  const multiDay = until - since > DAY;
  const fmtTick = (ms: number) => {
    if (!sub) return fmtDate.format(new Date(ms)).toUpperCase();
    const p = partsAt(ms);
    const clock = `${pad(p.hour)}:${pad(new Date(ms - startOfDay(p.date)).getUTCMinutes())}`;
    return multiDay ? `${fmtDate.format(new Date(ms)).toUpperCase()} ${clock}` : clock;
  };

  const rows: TraceRow[] = [];
  const index = new Map<number, TraceRow>();
  if (since < until) {
    let start = floor(since);
    let guard = 0;
    while (start < until && guard++ < 2000) {
      const end = next(start);
      const row: TraceRow = { t: start, end, label: fmtLabel(start), tick: fmtTick(start) };
      rows.push(row);
      index.set(start, row);
      start = end;
    }
  }
  const series = [...drawn.map((k) => infos.get(k)!), ...(hasRest ? [OTHER] : [])];
  const silent = new Map<number, Set<string>>();
  const measured = new Map<number, Set<string>>();
  const groupsRan = new Map<number, Set<string>>();
  const groupsMeasured = new Map<number, Set<string>>();
  rows.forEach((r, i) => r.__i = i);
  const mark = (m: Map<number, Set<string>>, i: number, key: string) => { const set = m.get(i) ?? new Set<string>(); set.add(key); m.set(i, set); };
  for (const t of inWindow) {
    const row = index.get(floor(turnMs(t)));
    if (!row) continue;
    const key = turnGroupKey(t, by);
    const i = Number(row.__i);
    const target = drawnSet.has(key) ? key : 'Other';
    mark(groupsRan, i, key);
    const v = metricValue(t, metric);
    if (v === null) { mark(silent, i, target); continue; }
    mark(groupsMeasured, i, key);
    mark(measured, i, target);
    row[target] = (Number(row[target]) || 0) + v;
  }
  const gaps = new Map<number, Set<string>>();
  const partials = new Map<number, Set<string>>();
  for (const [i, keys] of silent) {
    for (const k of keys) mark(measured.get(i)?.has(k) ? partials : gaps, i, k);
  }
  const unreported = new Map<number, string[]>();
  const silentGroups = new Map<number, Set<string>>();
  for (const [i, keys] of groupsRan) {
    const quiet = [...keys].filter((k) => !groupsMeasured.get(i)?.has(k));
    if (quiet.length) { unreported.set(i, quiet.map((k) => infos.get(k)!.label)); silentGroups.set(i, new Set(quiet)); }
  }
  if (cumulative) {
    // A running sum remembers. Once anything is missing every later value is a lower bound, and what was already measured stays on the line.
    const running: Record<string, number> = {};
    const short = new Set<string>();
    const groupsQuiet = new Set<string>();
    const groupsSeen = new Set<string>();
    rows.forEach((row, i) => {
      for (const s of series) {
        running[s.key] = (running[s.key] ?? 0) + (Number(row[s.key]) || 0);
        row[s.key] = running[s.key];
        if (gaps.get(i)?.has(s.key) || partials.get(i)?.has(s.key)) short.add(s.key);
        if (!short.has(s.key)) continue;
        if (running[s.key] > 0) { gaps.get(i)?.delete(s.key); mark(partials, i, s.key); } else mark(gaps, i, s.key);
      }
      for (const k of groupsRan.get(i) ?? []) (groupsMeasured.get(i)?.has(k) ? groupsSeen : groupsQuiet).add(k);
      const quiet = [...groupsQuiet].filter((k) => !groupsSeen.has(k));
      if (quiet.length) { unreported.set(i, quiet.map((k) => infos.get(k)!.label)); silentGroups.set(i, new Set(quiet)); } else { unreported.delete(i); silentGroups.delete(i); }
    });
  }

  const lines = ranked.map(([key, e]) => ({ key, value: e.value, turns: e.turns, reported: e.reported, partial: e.partial, info: infos.get(key)! }));
  const reported = lines.reduce((s, l) => s + l.reported, 0);
  return { rows, series, lines, total: measuredAny ? lines.reduce((s, l) => s + l.value, 0) : null, reported, turns: inWindow.filter((t) => !t.log).length, records: inWindow.length, gaps, partials, unreported, silentGroups };
}
