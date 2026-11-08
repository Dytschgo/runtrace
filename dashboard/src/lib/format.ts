const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const isKnown = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const fmtInt = (v: number) => nf.format(Math.round(v));
export const fmtCompact = (v: number) => (Math.abs(v) < 10_000 ? nf.format(Math.round(v)) : compact.format(v));

export function fmtPct(ratio: number, digits = 0) {
  if (ratio > 0 && ratio * 100 < 1 && digits === 0) return '<1%';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!isKnown(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtBytes(v: number) {
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = v;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions) {
  const key = tz + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }); fmtCache.set(key, f); }
  return f;
}

export function validDate(iso: unknown): Date | null {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(iso: unknown, tz: string) {
  const d = validDate(iso);
  return d ? dtf(tz, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) : '—';
}
export function fmtShortDateTime(iso: unknown, tz: string) {
  const d = validDate(iso);
  return d ? dtf(tz, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) : '—';
}
export function fmtClock(iso: unknown, tz: string) {
  const d = validDate(iso);
  return d ? dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) : '—';
}
export function fmtDay(iso: unknown, tz: string) {
  const d = validDate(iso);
  return d ? dtf(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(d) : '—';
}

export function fmtRelative(iso: unknown, now = Date.now()) {
  const d = validDate(iso);
  if (!d) return 'unknown';
  const s = Math.round((now - d.getTime()) / 1000);
  // Pages keep a clock that ticks once a minute, and machines' clocks differ a little, so a reading a few minutes ahead is a fresh one.
  if (s < -300) return 'in the future';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface LocalParts { date: string; hour: number; weekday: number }
/** Calendar date, hour and Monday-first weekday of an instant in a timezone. */
export function localParts(iso: string | Date, tz: string): LocalParts {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const parts = dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), weekday };
}

/** The UTC instant of local midnight on a yyyy-mm-dd date in a timezone. */
export function zonedDayStart(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const parts = dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    guess -= Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - target;
  }
  return new Date(guess);
}

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const MOJIBAKE = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–-™]{1,3}/g;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Repairs UTF-8 that was decoded as Windows-1252 (for example "Â·" to "·"), for display only. Anything that does not decode stays as stored. */
export function repairText(s: string): string {
  if (!s) return s;
  return s.replace(MOJIBAKE, (run) => {
    const bytes: number[] = [];
    for (const ch of run) {
      const c = ch.codePointAt(0)!;
      const b = c <= 0xff ? c : CP1252[c];
      if (b === undefined) return run;
      bytes.push(b);
    }
    try { return strictUtf8.decode(new Uint8Array(bytes)); } catch { return run; }
  });
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Za-z0-9]/g;
/** Prepares captured text for reading: encoding repaired, terminal control codes removed, blank runs collapsed. */
export function cleanText(s: string): string {
  return repairText(s).replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
}

export function snippet(text: string, needle: string, radius = 90): { before: string; match: string; after: string } {
  const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (i < 0) return { before: text.slice(0, radius * 2), match: '', after: '' };
  const start = Math.max(0, i - radius);
  const end = i + needle.length;
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, i),
    match: text.slice(i, end),
    after: text.slice(end, end + radius) + (end + radius < text.length ? '…' : ''),
  };
}

export function shortId(id: string) {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}
