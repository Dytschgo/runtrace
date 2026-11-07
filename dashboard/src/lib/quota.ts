const MINUTE = 60_000;
/** Used at or above this, a window is marked so it is seen before it refuses work. */
export const QUOTA_HIGH = 80;
const HOUR = 60 * MINUTE;

export interface QuotaReading { at: number; used: number; resetAt: number | null }
export interface Pace {
  /** Percentage points used per hour over the readings looked at. */
  perHour: number;
  /** How far back the readings reach, so the projection can say what it is based on. */
  basisMs: number;
  /** When the window would be full at this pace, or null when it would last until its reset. */
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
