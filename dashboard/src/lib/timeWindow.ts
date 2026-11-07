import { useSyncExternalStore } from 'react';
import type { Filters } from './filters';
import { localParts, validDate, zonedDayStart } from './format';
import type { HourRow } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** One bar on the slider: a local day, or one hour when zoomed in. `end` is exclusive. */
export interface Slot { key: string; start: number; end: number; value: number }
export type SlotUnit = 'day' | 'hour';
export type SlotWindow = [start: number, end: number];

export const nextDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** Every local day from the first observed record to the latest, so empty days keep their place on the track. */
export function daySlots(rows: HourRow[], tz: string, from?: number, to?: number): Slot[] {
  const counts = new Map<string, number>();
  let first = from;
  let last = to;
  for (const r of rows) {
    const ms = Date.parse(r.hour);
    if (Number.isNaN(ms)) continue;
    if (from === undefined && (first === undefined || ms < first)) first = ms;
    if (to === undefined && (last === undefined || ms > last)) last = ms;
    if ((from !== undefined && ms < from) || (to !== undefined && ms >= to)) continue;
    const { date } = localParts(new Date(ms), tz);
    counts.set(date, (counts.get(date) ?? 0) + r.prompts);
  }
  if (first === undefined || last === undefined) return [];
  const slots: Slot[] = [];
  let day = localParts(new Date(first), tz).date;
  const finalDay = localParts(new Date(to !== undefined ? to - 1 : last), tz).date;
  for (let guard = 0; day <= finalDay && guard < 4000; guard++) {
    const after = nextDay(day);
    slots.push({ key: day, start: zonedDayStart(day, tz).getTime(), end: zonedDayStart(after, tz).getTime(), value: counts.get(day) ?? 0 });
    day = after;
  }
  return slots;
}

/** Every hour in a range. Quiet hours stay on the track, including the current one. */
export function hourSlots(rows: HourRow[], from: number, to: number): Slot[] {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const ms = Date.parse(r.hour);
    if (!Number.isNaN(ms)) counts.set(ms, (counts.get(ms) ?? 0) + r.prompts);
  }
  const slots: Slot[] = [];
  const first = Math.floor(from / HOUR) * HOUR;
  for (let t = first; t < to; t += HOUR) slots.push({ key: String(t), start: t, end: t + HOUR, value: counts.get(t) ?? 0 });
  return slots;
}

/** `framed` is a preset's own stretch of the day track, so its window is a band you can grab rather than a sliver. */
export interface Domain { slots: Slot[]; unit: SlotUnit; zoomed: boolean; openEnd: boolean; framed?: boolean }

/** How much of the day track a preset opens on: a few times its own length. */
export const PRESET_FRAME: Record<string, number> = { '7d': 35 * DAY, '30d': 120 * DAY };

/** What the track covers. A zoom picks its own range, short presets look at recent hours, and anything else sees the whole history in days. */
export function sliderDomain(rows: HourRow[], f: Pick<Filters, 'range' | 'since' | 'until'>, zoom: { from?: string; to?: string; dayTrack?: boolean }, tz: string, now = Date.now()): Domain {
  const from = zoom.from ? Date.parse(zoom.from) : NaN;
  const to = zoom.to ? Date.parse(zoom.to) : NaN;
  if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) {
    if (to - from <= 14 * DAY) return { slots: hourSlots(rows, from, to), unit: 'hour', zoomed: true, openEnd: to >= now };
    return { slots: daySlots(rows, tz, from, to), unit: 'day', zoomed: true, openEnd: to >= now };
  }
  // The last bar is the hour we are in, never one that has not started.
  const bar = Math.floor(now / HOUR) * HOUR + HOUR;
  if (f.range === '1h' || f.range === '6h') return { slots: hourSlots(rows, now - DAY, bar), unit: 'hour', zoomed: false, openEnd: true };
  if (f.range === '24h') return { slots: hourSlots(rows, now - 3 * DAY, bar), unit: 'hour', zoomed: false, openEnd: true };
  // A short window opened by link shows its own hours, with room to move either way. One made by dragging keeps the track it was dragged on.
  if (!f.range && !zoom.dayTrack && validDate(f.since)) {
    const start = Date.parse(f.since as string);
    const end = validDate(f.until) ? Date.parse(f.until as string) : now;
    // A window that has not started yet has no hours to show around it, so it sits off the day track and names its own dates.
    if (end - start <= 3 * DAY && end > start && start < now) {
      const pad = Math.max(6 * HOUR, end - start);
      const to = Math.min(end + pad, bar);
      return { slots: hourSlots(rows, start - pad, to), unit: 'hour', zoomed: false, openEnd: to >= now };
    }
  }
  const days = daySlots(rows, tz);
  const frame = f.range && !zoom.dayTrack ? PRESET_FRAME[f.range] : undefined;
  if (frame) {
    const recent = days.filter((d) => d.end > now - frame);
    if (recent.length >= 2 && recent.length < days.length) return { slots: recent, unit: 'day', zoomed: false, openEnd: true, framed: true };
  }
  // History of a single day still gets a track to move along, in hours.
  if (days.length === 1) return { slots: hourSlots(rows, days[0].start, Math.min(days[0].end, bar)), unit: 'hour', zoomed: false, openEnd: days[0].end >= now };
  return { slots: days, unit: 'day', zoomed: false, openEnd: true };
}

/** Where the filters sit on the track. Times outside it clamp to its ends. */
export function windowFromFilters(slots: Slot[], f: Pick<Filters, 'since' | 'until'>): SlotWindow {
  const last = Math.max(0, slots.length - 1);
  if (!slots.length) return [0, 0];
  const locate = (iso: string | undefined, fallback: number) => {
    if (!validDate(iso)) return fallback;
    const ms = Date.parse(iso as string);
    if (ms < slots[0].start) return 0;
    if (ms >= slots[last].end) return last;
    const i = slots.findIndex((s) => ms >= s.start && ms < s.end);
    return i < 0 ? fallback : i;
  };
  const start = locate(f.since, 0);
  return [start, Math.max(start, locate(f.until, last))];
}

export interface WindowRange { since: string | null; until: string | null }

/** The window as a query. The whole unzoomed history is no filter at all, and a window reaching now stays open so new records join it. */
export function rangeFromWindow(d: Pick<Domain, 'slots' | 'zoomed' | 'openEnd' | 'unit' | 'framed'>, [start, end]: SlotWindow): WindowRange {
  const last = d.slots.length - 1;
  return {
    since: start <= 0 && !d.zoomed && !d.framed && d.unit === 'day' ? null : new Date(d.slots[start].start).toISOString(),
    until: end >= last && d.openEnd ? null : new Date(d.slots[end].end - 1).toISOString(),
  };
}

/** Zooming keeps at least a few bars to drag across, and widens around the middle to get them. */
export function zoomRange(startMs: number, endMs: number, minimum = 6 * HOUR, now = Date.now()): { from: number; to: number } {
  // The track ends with the hour we are in, so it never offers time that has not happened.
  const bar = Math.floor(now / HOUR) * HOUR + HOUR;
  if (endMs - startMs >= minimum) return { from: startMs, to: Math.min(endMs, bar) };
  const middle = (startMs + endMs) / 2;
  const from = Math.floor((middle - minimum / 2) / HOUR) * HOUR;
  const to = Math.min(from + minimum, bar);
  return { from: Math.min(from, to - minimum), to };
}

/**
 * The same length of time directly before or after a window, for "the hour before".
 * Stepping forward stops at now, which reopens the window so new records join it.
 */
export function stepWindow(since: number, until: number | null, direction: -1 | 1, now = Date.now(), length?: number): { since: string; until: string | null; track: { zs: string; ze: string } | null } {
  const end = length !== undefined ? since + length : until === null ? now : until;
  const span = end - since;
  let nextStart = since + direction * span;
  let nextEnd = end + direction * span;
  // Time has passed since the window was chosen, so arriving within a few minutes of now counts as arriving at now.
  if (nextEnd >= now - Math.min(5 * 60_000, span / 4)) { nextStart = now - span; nextEnd = now; }
  const open = nextEnd >= now;
  let track: { zs: string; ze: string } | null = null;
  if (span <= 3 * DAY) {
    const pad = Math.max(6 * HOUR, span);
    const bar = Math.floor(now / HOUR) * HOUR + HOUR;
    track = { zs: new Date(Math.floor((nextStart - pad) / HOUR) * HOUR).toISOString(), ze: new Date(Math.min(Math.ceil((nextEnd + pad) / HOUR) * HOUR, bar)).toISOString() };
  }
  // The end of a window is its last millisecond, so stepping back then forward lands exactly where it started.
  return { since: new Date(nextStart).toISOString(), until: open ? null : new Date(nextEnd - 1).toISOString(), track };
}

/** Handles sit on the edges of bars, so one selected bar is still a visible band. */
export const startEdge = (i: number, n: number) => (n ? (i / n) * 100 : 0);
export const endEdge = (i: number, n: number) => (n ? ((i + 1) / n) * 100 : 100);

export function moveWindow([start, end]: SlotWindow, which: 'start' | 'end' | 'both', to: number, n: number): SlotWindow {
  const last = n - 1;
  if (which === 'start') return [Math.min(Math.max(0, to), end), end];
  if (which === 'end') return [start, Math.max(Math.min(last, to), start)];
  const span = end - start;
  const at = Math.min(Math.max(0, to), last - span);
  return [at, at + span];
}

// The window while a handle is held. Numbers that can be derived in the browser follow it without waiting for the service.
let draft: WindowRange | null = null;
const listeners = new Set<() => void>();

export function setWindowDraft(next: WindowRange | null) {
  draft = next;
  listeners.forEach((l) => l());
}

export function useWindowDraft() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => draft);
}

/** The filters as they stand this instant, including a window still being dragged. */
export function withDraft<F extends Filters>(f: F, d: WindowRange | null): F {
  return d ? { ...f, since: d.since ?? undefined, until: d.until ?? undefined, range: undefined } : f;
}
