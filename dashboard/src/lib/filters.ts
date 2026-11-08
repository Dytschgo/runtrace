export const RANGES: Record<string, number> = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };

/** What the token overview opens on, so it loads quickly. Older history follows in the background. */
export const DEFAULT_RANGE = '7d';

export interface Filters {
  project?: string; model?: string; instance?: string; since?: string; until?: string; range?: string;
  /** A provider family. Never read from a link: only a chosen provider row sets it. */
  provider?: string;
}

const MINUTE = 60_000;

/** A date from a link, in the one form the service accepts. Anything that does not start like a calendar date is ignored. */
export function readDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The address with any value the dashboard ignores taken out: an unknown page, range or date. Null when nothing needs taking out.
 *  What is shown and what the address says then agree, and no Clear button offers to clear a filter that does nothing. */
export function cleanSearch(search: string, pages: readonly string[]): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  const drop = (key: string) => { params.delete(key); changed = true; };
  const page = params.get('page');
  if (page !== null && !pages.includes(page)) drop('page');
  const range = params.get('range');
  if (range !== null && range !== 'all' && !Object.hasOwn(RANGES, range)) drop('range');
  for (const key of ['since', 'until']) { const v = params.get(key); if (v !== null && !readDate(v)) drop(key); }
  return changed ? params.toString() : null;
}

/**
 * A preset is anchored to the minute, so "the last 24h" is exactly 24 hours and its query key still only changes once a minute.
 * A window ending in the future reaches now and stays live until that end has passed, so time that has not happened is never counted or compared.
 * A date that cannot be read is ignored, and a reversed pair is put the right way round.
 */
export function resolveFilters(params: URLSearchParams, now = Date.now(), defaultRange?: string): Filters {
  // A range the page does not know is treated as no range, so the default applies rather than the whole history.
  const given = params.get('range') ?? undefined;
  const range = given === 'all' || (given && Object.hasOwn(RANGES, given)) ? given : undefined;
  const f: Filters = {
    project: params.get('project') || undefined,
    model: params.get('model') || undefined,
    instance: params.get('instance') || undefined,
    since: readDate(params.get('since')),
    until: readDate(params.get('until')),
  };
  if (f.since && f.until && Date.parse(f.since) > Date.parse(f.until)) [f.since, f.until] = [f.until, f.since];
  if (f.until && Date.parse(f.until) >= now && !(f.since && Date.parse(f.since) > now)) f.until = undefined;
  // "all" is a choice, so only a page with nothing chosen falls back to the default.
  const preset = range && Object.hasOwn(RANGES, range) ? range : !range && !f.since && !f.until ? defaultRange : undefined;
  if (preset) {
    f.range = preset;
    f.since = new Date(Math.floor((now - RANGES[preset]) / MINUTE) * MINUTE).toISOString();
    f.until = undefined;
  }
  return f;
}

/** The same length of time directly before this window. The whole history has nothing before it. */
export function previousWindow(f: Filters, now = Date.now()): { since: string; until: string } | null {
  if (!f.since) return null;
  const start = Date.parse(f.since);
  if (Number.isNaN(start)) return null;
  const end = f.until ? Date.parse(f.until) : now;
  const span = f.range ? RANGES[f.range] : end - start;
  if (Number.isNaN(span) || span <= 0) return null;
  return { since: new Date(start - span).toISOString(), until: new Date(start - 1).toISOString() };
}

type FilterKey = 'project' | 'model' | 'provider' | 'instance' | 'time';

/**
 * Which filters each endpoint is sent. Project records carry no model, so a model filter would empty them.
 * Threads and agents are scanned whole per project so lineage is never cut by a time filter.
 */
export const ROUTE_FILTERS: Record<string, FilterKey[]> = {
  overview: ['project', 'model', 'provider', 'instance', 'time'],
  models: ['project', 'instance', 'time'],
  'activity/hourly': ['project', 'model', 'provider', 'instance', 'time'],
  projects: ['instance'],
  threads: ['project', 'instance'],
  agents: ['project', 'instance'],
  'tool-calls': ['project', 'model', 'instance', 'time'],
  'model-turns': ['project', 'model', 'instance', 'time'],
  'usage/projects': ['instance', 'time'],
  'usage/machines': ['project', 'time'],
  'usage/tools': ['project', 'model', 'provider', 'instance', 'time'],
  'usage/tool-hours': ['project', 'model', 'instance', 'time'],
  timeline: ['project', 'model', 'instance', 'time'],
  search: ['project', 'model', 'instance', 'time'],
};

export function apiParams(route: string, f: Filters, extra: Record<string, string | number | undefined> = {}): URLSearchParams {
  const keys = ROUTE_FILTERS[route] ?? [];
  const p = new URLSearchParams();
  if (keys.includes('project') && f.project) p.set('project', f.project);
  if (keys.includes('model') && f.model) p.set('model', f.model);
  if (keys.includes('provider') && f.provider) p.set('provider', f.provider);
  if (keys.includes('instance') && f.instance) p.set('instance', f.instance);
  if (keys.includes('time')) {
    if (f.since) p.set('since', f.since);
    if (f.until) p.set('until', f.until);
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p;
}

/** A test for instants in a window, with its ends read once rather than for every row. */
export function windowTest(f: Pick<Filters, 'since' | 'until'>): (ms: number) => boolean {
  const a = f.since ? Date.parse(f.since) : -Infinity;
  const b = f.until ? Date.parse(f.until) : Infinity;
  return (ms) => !(ms < a) && !(ms > b);
}

// Lists filter thousands of rows against the same window, so its ends are read once and kept.
const parsed = new Map<string, number>();
const parseOnce = (iso: string) => { let v = parsed.get(iso); if (v === undefined) { if (parsed.size > 64) parsed.clear(); v = Date.parse(iso); parsed.set(iso, v); } return v; };
export function inTimeRange(iso: string, f: Filters): boolean {
  const t = Date.parse(iso);
  if (f.since && t < parseOnce(f.since)) return false;
  if (f.until && t > parseOnce(f.until)) return false;
  return true;
}

export type PageScope = 'all' | 'no-model' | 'none';
export const PAGE_SCOPE: Record<string, PageScope> = {
  Projects: 'no-model',
  'Quota and Resets': 'none',
  Storage: 'none',
  'Data Quality': 'none',
  Settings: 'none',
};

/** How a window is written in the zoom trail: a preset by name, anything else by its two ends. */
export function windowToken(params: URLSearchParams): string {
  const range = params.get('range');
  if (range) return `r:${range}`;
  const since = params.get('since') ?? '';
  const until = params.get('until') ?? '';
  return since || until ? `s:${since}~${until}` : 'd:';
}

/** Opening a period keeps the window it came from, so zooming out goes back exactly one step. */
export function zoomInTrail(params: URLSearchParams): string {
  const trail = (params.get('up') ?? '').split(',').filter(Boolean);
  return [...trail, windowToken(params)].slice(-8).join(',');
}

type Patch = Record<string, string | null>;
const CLEAR_TRACK = { zs: null, ze: null, track: null, rp: null, offset: null } as const;

/**
 * One step out. A window opened from a wider one returns to it. Without a trail, a window reaching now widens to the next preset,
 * and a past window widens to four times its length around its middle, stopping at now. The longest preset widens to everything.
 */
export function zoomOutPatch(params: URLSearchParams, now = Date.now()): Patch {
  const trail = (params.get('up') ?? '').split(',').filter(Boolean);
  const last = trail.pop();
  const up = trail.length ? trail.join(',') : null;
  if (last) {
    if (last.startsWith('r:')) return { range: last.slice(2), since: null, until: null, up, ...CLEAR_TRACK };
    if (last.startsWith('s:')) {
      const [since, until] = last.slice(2).split('~');
      return { range: null, since: since || null, until: until || null, up, ...CLEAR_TRACK };
    }
    return { range: null, since: null, until: null, up, ...CLEAR_TRACK };
  }
  const f = resolveFilters(params, now, DEFAULT_RANGE);
  if (!f.since) return { range: 'all', since: null, until: null, up: null, ...CLEAR_TRACK };
  const start = Date.parse(f.since);
  const end = f.until ? Date.parse(f.until) + 1 : now;
  const span = end - start;
  if (!f.until) {
    const next = Object.entries(RANGES).find(([, ms]) => ms > span * 1.05);
    return next ? { range: next[0], since: null, until: null, up: null, ...CLEAR_TRACK } : { range: 'all', since: null, until: null, up: null, ...CLEAR_TRACK };
  }
  const middle = (start + end) / 2;
  const wideEnd = Math.min(now, middle + span * 2);
  const wideStart = wideEnd - span * 4;
  return { range: null, since: new Date(wideStart).toISOString(), until: wideEnd >= now - MINUTE ? null : new Date(wideEnd - 1).toISOString(), up: null, ...CLEAR_TRACK };
}

/** A window that starts later than now has not happened, so nothing in it is known, not even a zero. */
export const isFuture = (f: Pick<Filters, 'since'>, now = Date.now()) => !!f.since && Date.parse(f.since) > now;
