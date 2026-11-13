import type { TurnRow } from './entities';
import { localParts } from './format';
import { FAMILIES, type Provider } from './modelColors';

/** The agent program that ran a turn (Codex, Claude Code, Grok…), as T3 names its provider instance. Not the model's company. */
export type HarnessMeasure = 'turns' | 'tokens';

const NAMES: Record<string, string> = {
  codex: 'Codex', claudeAgent: 'Claude Code', claude: 'Claude Code', grok: 'Grok', muse: 'Muse', antigravity: 'Antigravity',
  gemini: 'Gemini CLI', cursor: 'Cursor', opencode: 'OpenCode', copilot: 'GitHub Copilot', pi: 'Pi',
};

export const NOT_RECORDED = 'not-recorded';

export function harnessName(key: string): string {
  if (key === NOT_RECORDED) return 'Not recorded';
  if (NAMES[key]) return NAMES[key];
  // A variant such as codex-meta reads as its base harness with the variant after it.
  const [base, ...rest] = key.split('-');
  if (NAMES[base] && rest.length) return `${NAMES[base]} (${rest.join(' ')})`;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The company whose mark and colour a harness carries. */
export function harnessFamily(key: string): Provider {
  if (/^codex/i.test(key)) return 'openai';
  if (/^claude/i.test(key)) return 'anthropic';
  if (/^grok/i.test(key)) return 'xai';
  if (/^muse/i.test(key)) return 'meta';
  if (/^(gemini|antigravity)/i.test(key)) return 'google';
  return 'other';
}

/** A second harness from a company it already has takes the next shade, by name, so no window or filter repaints one. */
const SHADE: Record<string, number> = { gemini: 1 };

/** A harness's colour comes from its name alone: its company's colour, and a variant such as codex-meta a lighter step of it. */
export function harnessColor(key: string): string {
  const family = FAMILIES[harnessFamily(key)];
  if (key === NOT_RECORDED) return 'oklch(0.42 0 none)';
  if (!key.includes('-')) return family[(SHADE[key] ?? 0) % family.length];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return family[1 + (Math.abs(hash) % (family.length - 1))];
}

export const harnessOf = (t: Pick<TurnRow, 'provider'>) => t.provider || NOT_RECORDED;

/** A turn's weight for a measure. Session-log hours are not turns, but their tokens count. Null means it adds nothing. */
export function harnessWeight(t: Pick<TurnRow, 'log' | 'total'>, measure: HarnessMeasure): number | null {
  if (measure === 'turns') return t.log ? null : 1;
  return t.total ?? null;
}

export interface HarnessTotal { key: string; value: number; turns: number }

export function harnessTotals(turns: TurnRow[], measure: HarnessMeasure): HarnessTotal[] {
  const by = new Map<string, HarnessTotal>();
  for (const t of turns) {
    const w = harnessWeight(t, measure);
    const key = harnessOf(t);
    const row = by.get(key) ?? { key, value: 0, turns: 0 };
    if (w !== null) row.value += w;
    if (!t.log) row.turns += 1;
    by.set(key, row);
  }
  return [...by.values()].filter((r) => r.value > 0).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

export interface BalanceDay {
  day: string;
  /** What each ran over the days this point covers: the day itself, or the trailing week on a long window. */
  a: number;
  b: number;
  /** How many days the point covers, fewer than asked for at the start of the window. */
  covers: number;
  /** A's share minus B's share of the two, in percentage points from -100 to 100. Null when neither ran in those days. */
  diff: number | null;
}

const nextDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** Over this many days a single day is too noisy to read, so each point covers the week up to it. */
export const SMOOTH_AFTER_DAYS = 21;
export const SMOOTH_DAYS = 7;

/**
 * Balance between two harnesses in the display timezone, one point per day from the first to the last.
 * `span` is how many days each point covers, ending on its own day.
 */
export function balanceByDay(turns: TurnRow[], a: string, b: string, measure: HarnessMeasure, tz: string, span = 1): BalanceDay[] {
  const days = new Map<string, { a: number; b: number }>();
  for (const t of turns) {
    const key = harnessOf(t);
    if (key !== a && key !== b) continue;
    const w = harnessWeight(t, measure);
    if (!w) continue;
    const { date } = localParts(t.occurred_at, tz);
    const row = days.get(date) ?? { a: 0, b: 0 };
    if (key === a) row.a += w; else row.b += w;
    days.set(date, row);
  }
  const sorted = [...days.keys()].sort();
  if (!sorted.length) return [];
  const daily: { day: string; a: number; b: number }[] = [];
  for (let day = sorted[0]; day <= sorted[sorted.length - 1]; day = nextDate(day)) daily.push({ day, ...(days.get(day) ?? { a: 0, b: 0 }) });
  let sa = 0;
  let sb = 0;
  return daily.map((d, i) => {
    sa += d.a; sb += d.b;
    if (i >= span) { sa -= daily[i - span].a; sb -= daily[i - span].b; }
    const sum = sa + sb;
    return { day: d.day, a: sa, b: sb, covers: Math.min(span, i + 1), diff: sum ? ((sa - sb) / sum) * 100 : null };
  });
}

/** Shares of the two over the whole window, as fractions that add to one. Null when neither ran. */
export function balanceShares(turns: TurnRow[], a: string, b: string, measure: HarnessMeasure): { a: number; b: number } | null {
  let sa = 0;
  let sb = 0;
  for (const t of turns) {
    const key = harnessOf(t);
    if (key !== a && key !== b) continue;
    const w = harnessWeight(t, measure) ?? 0;
    if (key === a) sa += w; else sb += w;
  }
  return sa + sb ? { a: sa / (sa + sb), b: sb / (sa + sb) } : null;
}

/** Whether a turn ran in a sub-agent thread: delegated work rather than a turn a person started. Unknown threads count as started. */
export type Who = 'all' | 'started' | 'delegated';
export function whoFilter(who: Who, childThreads: Set<string>): (t: Pick<TurnRow, 'thread_id'>) => boolean {
  if (who === 'all') return () => true;
  return who === 'delegated' ? (t) => childThreads.has(t.thread_id) : (t) => !childThreads.has(t.thread_id);
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** How each harness behaved, from its turns. Null means no turn reported it, never zero. */
export interface HarnessStats {
  key: string;
  turns: number;
  tokens: number | null;
  /** Median total of the turns that reported a complete one. */
  tokensPerTurn: number | null;
  /** Cached input as a share of input, over turns that reported both. */
  cacheShare: number | null;
  medianMs: number | null;
  statusKnown: number;
  failed: number;
  stopped: number;
  /** Turns that ran in a sub-agent thread. */
  delegated: number;
  /** Turns that started sub-agents of their own, of the turns that said. */
  spawned: number;
  spawnKnown: number;
  models: { model: string; turns: number }[];
}

export function harnessStats(turns: TurnRow[], childThreads: Set<string>): HarnessStats[] {
  type Acc = { s: HarnessStats; totals: number[]; durations: number[]; cached: number; input: number; models: Map<string, number> };
  const by = new Map<string, Acc>();
  for (const t of turns) {
    if (t.log) continue;
    const key = harnessOf(t);
    let e = by.get(key);
    if (!e) {
      e = { s: { key, turns: 0, tokens: null, tokensPerTurn: null, cacheShare: null, medianMs: null, statusKnown: 0, failed: 0, stopped: 0, delegated: 0, spawned: 0, spawnKnown: 0, models: [] }, totals: [], durations: [], cached: 0, input: 0, models: new Map() };
      by.set(key, e);
    }
    const s = e.s;
    s.turns += 1;
    if (t.total !== null) { e.totals.push(t.total); s.tokens = (s.tokens ?? 0) + t.total; }
    if (t.cached !== null && t.input !== null && t.input > 0) { e.cached += t.cached; e.input += t.input; }
    if (t.duration !== null && t.duration >= 0) e.durations.push(t.duration);
    if (t.status) {
      s.statusKnown += 1;
      if (t.status === 'failed') s.failed += 1;
      else if (t.status === 'cancelled' || t.status === 'interrupted') s.stopped += 1;
    }
    if (childThreads.has(t.thread_id)) s.delegated += 1;
    if (t.hasSubagents !== null) { s.spawnKnown += 1; if (t.hasSubagents) s.spawned += 1; }
    if (t.model) e.models.set(t.model, (e.models.get(t.model) ?? 0) + 1);
  }
  return [...by.values()].map(({ s, totals, durations, cached, input, models }) => ({
    ...s,
    tokensPerTurn: median(totals),
    cacheShare: input ? cached / input : null,
    medianMs: median(durations),
    models: [...models].map(([model, n]) => ({ model, turns: n })).sort((x, y) => y.turns - x.turns),
  })).sort((x, y) => y.turns - x.turns || x.key.localeCompare(y.key));
}

/** Each project's turns or tokens split by harness, busiest project first. */
export interface ProjectSplit { project: string; total: number; parts: { key: string; value: number }[] }
export function harnessByProject(turns: TurnRow[], measure: HarnessMeasure): ProjectSplit[] {
  const by = new Map<string, Map<string, number>>();
  for (const t of turns) {
    const w = harnessWeight(t, measure);
    if (!w) continue;
    const project = t.project_id || 'none';
    const m = by.get(project) ?? new Map<string, number>();
    m.set(harnessOf(t), (m.get(harnessOf(t)) ?? 0) + w);
    by.set(project, m);
  }
  return [...by].map(([project, m]) => {
    const parts = [...m].map(([key, value]) => ({ key, value })).sort((x, y) => y.value - x.value);
    return { project, total: parts.reduce((s, p) => s + p.value, 0), parts };
  }).sort((x, y) => y.total - x.total || x.project.localeCompare(y.project));
}

/** Turns or tokens per local hour of the day, 0 to 23, split by harness. */
export function harnessByHour(turns: TurnRow[], measure: HarnessMeasure, tz: string): { hour: number; values: Map<string, number> }[] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, values: new Map<string, number>() }));
  for (const t of turns) {
    const w = harnessWeight(t, measure);
    if (!w) continue;
    const { hour } = localParts(t.occurred_at, tz);
    const m = hours[hour].values;
    m.set(harnessOf(t), (m.get(harnessOf(t)) ?? 0) + w);
  }
  return hours;
}

/** Quota is recorded per provider account. This is the harness that spends it. */
const QUOTA_HARNESS: Record<string, string> = { claude: 'claudeAgent', anthropic: 'claudeAgent', codex: 'codex', openai: 'codex' };
export const quotaHarness = (provider: string) => QUOTA_HARNESS[provider] ?? provider;

export interface LimitHit { provider: string; window: string; first_hit_at: string; reset_at: string | null; hits: number }
export interface LimitEpisode {
  harness: string; window: string; at: number; until: number; hits: number;
  /** A's share of A and B while the limit held, and over the same length of time just before. Null when neither ran. */
  during: number | null; before: number | null;
}

/** What happened to the balance while a harness waited for its limit to reset, against the same span just before. */
export function limitEpisodes(hits: LimitHit[], turns: TurnRow[], a: string, b: string, measure: HarnessMeasure, now: number): LimitEpisode[] {
  const share = (from: number, to: number) => {
    let sa = 0;
    let sb = 0;
    for (const t of turns) {
      const key = harnessOf(t);
      if (key !== a && key !== b) continue;
      const at = t.at ?? Date.parse(t.occurred_at);
      if (at < from || at >= to) continue;
      const w = harnessWeight(t, measure) ?? 0;
      if (key === a) sa += w; else sb += w;
    }
    return sa + sb ? sa / (sa + sb) : null;
  };
  return hits.flatMap((h) => {
    const at = Date.parse(h.first_hit_at);
    if (!Number.isFinite(at)) return [];
    const reset = h.reset_at ? Date.parse(h.reset_at) : NaN;
    // A wait still running is measured up to now, and one with no known reset is not measured at all.
    const until = Math.min(Number.isFinite(reset) ? reset : at, now);
    const span = until - at;
    return [{ harness: quotaHarness(h.provider), window: h.window, at, until, hits: h.hits, during: span > 0 ? share(at, until) : null, before: span > 0 ? share(at - span, at) : null }];
  }).sort((x, y) => x.at - y.at);
}
