const MINUTE = 60_000;
/** With this much left or less, a window is marked so it is seen before it refuses work. */
export const QUOTA_LOW = 20;
/** What is left of a window, from what was used. Over-quota readings above 100 leave nothing. */
export const leftOf = (used: number) => Math.min(100, Math.max(0, 100 - used));
const HOUR = 60 * MINUTE;

export interface QuotaReading { at: number; used: number; resetAt: number | null }
export const MAX_QUOTA_GAP = 20 * MINUTE;
export interface TrackGap { start_epoch_ms: number; end_epoch_ms: number }
/** Never join a long unobserved interval or carry a reading beyond its reset. */
export function quotaTrack(readings: QuotaReading[], from: number, until: number): { segments: QuotaReading[][]; gaps: TrackGap[] } {
  const sorted = readings.filter((p) => Number.isFinite(p.at) && Number.isFinite(p.used) && p.at <= until).sort((a, b) => a.at - b.at);
  const points = sorted.filter((p) => p.at >= from);
  const previous = sorted.filter((p) => p.at < from).at(-1);
  if (previous && from - previous.at <= MAX_QUOTA_GAP && (previous.resetAt === null || previous.resetAt > from)) points.unshift({ ...previous, at: from });
  if (!points.length) return { segments: [], gaps: [{ start_epoch_ms: from, end_epoch_ms: until }] };
  const segments: QuotaReading[][] = [[points[0]]];
  const gaps: TrackGap[] = [];
  if (points[0].at > from) gaps.push({ start_epoch_ms: from, end_epoch_ms: points[0].at });
  for (let i = 1; i < points.length; i++) {
    const prior = points[i - 1]; const next = points[i];
    const crossedReset = prior.resetAt !== null && prior.resetAt <= next.at && prior.resetAt !== next.resetAt;
    if (next.at - prior.at > MAX_QUOTA_GAP || crossedReset) {
      gaps.push({ start_epoch_ms: prior.at, end_epoch_ms: next.at });
      segments.push([next]);
    } else segments.at(-1)!.push(next);
  }
  const last = points.at(-1)!;
  const observedUntil = Math.min(until, last.resetAt ?? until);
  if (until - last.at > MAX_QUOTA_GAP || observedUntil < until) gaps.push({ start_epoch_ms: last.at, end_epoch_ms: until });
  else if (observedUntil > last.at) segments.at(-1)!.push({ ...last, at: observedUntil });
  return { segments, gaps };
}
export interface Pace {
  /** Percentage points used per hour over the readings looked at. */
  perHour: number;
  /** How far back the readings reach, so the projection can say what it is based on. */
  basisMs: number;
  /** When nothing would be left at this pace, or null when it would last until its reset. */
  fullAt: number | null;
}

/**
 * The pace of one quota window, from its own recent readings only. A reading from another reset belongs to another window and is never mixed in.
 * It looks back a fifth of the window, at least an hour and at most a day, and needs readings spanning a quarter of that to say anything.
 * Agents can report a slightly older figure now and then, so the highest reading so far is taken as what is used; within one window use never goes down.
 * This is a projection of recent use, not a reading, and is always labelled as one.
 */
export function quotaPace(readings: QuotaReading[], windowMinutes: number | null, resetAt: number | null, now: number): Pace | null {
  const look = Math.min(24 * HOUR, Math.max(HOUR, ((windowMinutes ?? 300) * MINUTE) / 5));
  let own = readings
    .filter((r) => r.at <= now && (resetAt === null || r.resetAt === null || Math.abs(r.resetAt - resetAt) <= 5 * MINUTE))
    .sort((a, b) => a.at - b.at);
  // Without a reset time, a large drop is the only sign of a reset, so only what follows the last one counts.
  if (resetAt === null) {
    let cut = 0;
    for (let i = 1; i < own.length; i++) if (own[i].used < own[i - 1].used - 5) cut = i;
    own = own.slice(cut);
  }
  own = own.filter((r) => r.at >= now - look);
  if (own.length < 2) return null;
  const first = own[0];
  const last = own[own.length - 1];
  const basisMs = last.at - first.at;
  if (basisMs < Math.max(15 * MINUTE, look / 4)) return null;
  const used = Math.max(...own.map((r) => r.used));
  const perHour = ((used - first.used) / basisMs) * HOUR;
  if (perHour <= 0) return { perHour: 0, basisMs, fullAt: null };
  const fullAt = last.at + ((100 - used) / perHour) * HOUR;
  return { perHour, basisMs, fullAt: resetAt !== null && fullAt >= resetAt ? null : fullAt };
}

/** A short span for a label: minutes under an hour and a half, whole hours above. */
export const spanText = (ms: number) => (ms < 90 * MINUTE ? `${Math.max(1, Math.round(ms / MINUTE))}m` : `${Math.round(ms / HOUR)}h`);

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const time = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const text = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Windows by their stored names, the way T3 labels them. */
const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', weekly: 'Weekly', daily: 'Daily', usage_window: 'Usage window', primary: '5-hour', secondary: 'Weekly' };
export function windowName(w: unknown): string {
  if (typeof w !== 'string' || !w) return 'Window';
  const model = /^seven_day_(.+)$/.exec(w);
  if (model) return `Weekly · ${model[1].charAt(0).toUpperCase()}${model[1].slice(1).replace(/_/g, ' ')}`;
  return WINDOW_NAMES[w] ?? w.replace(/_/g, ' ');
}

/** A window's name: the common ones by their id, others as the harness labels them. */
export const windowLabel = (window: string, label: string | null) => WINDOW_NAMES[window] ?? label ?? windowName(window);

export interface QuotaWindow {
  window: string;
  /** The harness's own name for it, when it gave one. */
  label: string | null;
  used: number | null;
  resetAt: number | null;
  minutes: number | null;
  /** When this figure was read, by T3 or by the agent itself. */
  readAt: number | null;
}
export interface ResetCredits { available: number | null; nextExpiresAt: number | null; options: { label: string; description: string | null; available: number | null; expiresAt: number | null }[] }
export interface QuotaCard {
  /** The name quota is stored under: claude, codex, grok… */
  key: string;
  /** The harness that spends it, as T3 names it. */
  harness: string;
  plan: string | null;
  /** When T3, or Runtrace for a harness T3 does not check, last asked this harness, if either did. */
  checkedAt: number | null;
  checkedBy: 't3' | 'runtrace' | null;
  windows: QuotaWindow[];
  credits: ResetCredits | null;
}
/** A harness that has no limits to show, and why: it runs locally, its provider sends no figures, or the check failed. */
export interface SilentHarness { harness: string; why: string; kind: 'local' | 'none' | 'failed'; plan: string | null }

/**
 * One card per harness with limits. T3's live answer says which windows a harness has; each window shows the newest figure,
 * T3's or the agent's own reading, whichever came later. A harness T3 does not know keeps the stored readings alone.
 */
export function quotaCards(current: Row[], live: Row[], harnessOf: (key: string) => string): { cards: QuotaCard[]; silent: SilentHarness[] } {
  const stored = new Map<string, Row[]>();
  for (const r of current) {
    const key = String(r.provider ?? 'agent');
    stored.set(key, [...(stored.get(key) ?? []), r]);
  }
  const fromStored = (r: Row): QuotaWindow => ({
    window: String(r.window ?? 'window'),
    label: null,
    used: num(r.used_percentage) ?? (num(r.remaining_percentage) !== null ? 100 - (r.remaining_percentage as number) : null),
    resetAt: time(r.reset_at),
    minutes: num(r.window_minutes),
    readAt: time(r.sampled_at),
  });
  const cards: QuotaCard[] = [];
  const silent: SilentHarness[] = [];
  const seen = new Set<string>();
  for (const h of live) {
    const key = text(h.quota_key) ?? String(h.harness);
    const harness = text(h.harness) ?? key;
    const windows = Array.isArray(h.windows) ? (h.windows as Row[]) : [];
    if (!windows.length) {
      const u = (h.unavailable ?? null) as Row | null;
      const why = u?.reason === 'probeFailed' ? `The check failed${text(u.message) ? `: ${text(u.message)}` : ''}`
        : text(u?.message) ?? (h.reports_limits === false ? 'Nothing checks its limits' : u?.reason === 'unsupported' ? 'Its limits cannot be read' : 'Reported no limits');
      const kind = u?.reason === 'local' ? 'local' : u?.reason === 'probeFailed' ? 'failed' : 'none';
      // A harness with stored readings still gets its card; the reason is only for those with nothing at all.
      if (!stored.has(key)) { silent.push({ harness, why, kind, plan: text(h.plan) }); continue; }
    }
    seen.add(key);
    const checkedAt = time(h.checked_at);
    const own = new Map((stored.get(key) ?? []).map((r) => [String(r.window), r]));
    const list = windows.length ? windows.map((w): QuotaWindow => {
      const mine: QuotaWindow = { window: String(w.window), label: text(w.label), used: num(w.used_percentage), resetAt: time(w.reset_at), minutes: num(w.window_minutes), readAt: checkedAt };
      const theirs = own.get(mine.window);
      const other = theirs ? fromStored(theirs) : null;
      return other && other.readAt !== null && (mine.readAt === null || other.readAt > mine.readAt) ? { ...other, label: mine.label } : mine;
    }) : [...own.values()].map(fromStored);
    const c = (h.credits ?? null) as Row | null;
    cards.push({
      key, harness,
      plan: text(h.plan) ?? (stored.get(key) ?? []).map((r) => text(r.plan)).find(Boolean) ?? null,
      checkedAt,
      checkedBy: h.checked_by === 'runtrace' ? 'runtrace' : 't3',
      windows: list,
      credits: c ? {
        available: num(c.available),
        nextExpiresAt: time(c.next_expires_at),
        options: (Array.isArray(c.options) ? (c.options as Row[]) : []).map((o) => ({ label: text(o.label) ?? 'Reset', description: text(o.description), available: num(o.available), expiresAt: time(o.expires_at) })),
      } : null,
    });
  }
  for (const [key, rows] of stored) {
    if (seen.has(key)) continue;
    cards.push({ key, harness: harnessOf(key), plan: rows.map((r) => text(r.plan)).find(Boolean) ?? null, checkedAt: null, checkedBy: null, windows: rows.map(fromStored), credits: null });
  }
  return { cards, silent };
}

/** How fresh the last check is: under 10 minutes is live, over an hour means nothing has been asking. */
export function freshness(checkedAt: number | null, now: number): 'live' | 'recent' | 'stale' | 'unknown' {
  if (checkedAt === null) return 'unknown';
  const age = now - checkedAt;
  return age <= 10 * MINUTE ? 'live' : age <= HOUR ? 'recent' : 'stale';
}
