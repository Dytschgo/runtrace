import { describe, expect, it } from 'vitest';
import { zoomInTrail, zoomOutPatch } from './filters';
import { daySlots, rangeFromWindow, sliderDomain } from './timeWindow';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const DAY = 86_400_000;
const p = (s: string) => new URLSearchParams(s);

describe('zooming out one step', () => {
  it('returns to the preset a period was opened from', () => {
    const trail = zoomInTrail(p('range=7d'));
    expect(trail).toBe('r:7d');
    const out = zoomOutPatch(p(`since=2026-11-05T00:00:00.000Z&until=2026-11-05T23:59:59.999Z&up=${trail}`), NOW);
    expect(out).toMatchObject({ range: '7d', since: null, until: null, up: null });
  });
  it('walks back through nested openings one at a time', () => {
    const first = zoomInTrail(p('range=30d'));
    const second = zoomInTrail(p(`since=2026-11-01T00:00:00.000Z&until=2026-11-07T00:00:00.000Z&up=${first}`));
    const out = zoomOutPatch(p(`since=2026-11-03T00:00:00.000Z&until=2026-11-03T23:59:59.999Z&up=${second}`), NOW);
    expect(out).toMatchObject({ range: null, since: '2026-11-01T00:00:00.000Z', until: '2026-11-07T00:00:00.000Z', up: 'r:30d' });
  });
  it('returns to the default window when that was where it began', () => {
    expect(zoomOutPatch(p(`since=2026-11-05T00:00:00.000Z&up=${zoomInTrail(p(''))}`), NOW)).toMatchObject({ range: null, since: null, until: null });
  });
  it('widens a live window to the next preset, and the longest to everything', () => {
    expect(zoomOutPatch(p('range=24h'), NOW).range).toBe('7d');
    expect(zoomOutPatch(p(''), NOW).range).toBe('30d');
    expect(zoomOutPatch(p('range=30d'), NOW).range).toBe('all');
  });
  it('widens a past window around its middle without passing now', () => {
    const out = zoomOutPatch(p('since=2026-10-10T00:00:00.000Z&until=2026-10-10T23:59:59.999Z'), NOW);
    expect(Date.parse(out.until!) + 1 - Date.parse(out.since!)).toBe(4 * DAY);
    const late = zoomOutPatch(p('since=2026-11-06T00:00:00.000Z&until=2026-11-06T23:59:59.999Z'), NOW);
    expect(late.until).toBeNull();
  });
});

describe('a preset framed on the track', () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ hour: new Date(NOW - i * DAY).toISOString(), prompts: 1 }));
  it('opens 7d on five weeks rather than the whole history', () => {
    const d = sliderDomain(rows, { range: '7d' }, {}, 'UTC', NOW);
    expect(d.framed).toBe(true);
    expect(d.slots.length).toBeGreaterThanOrEqual(35);
    expect(d.slots.length).toBeLessThanOrEqual(36);
  });
  it('shows the whole history when asked', () => {
    const d = sliderDomain(rows, { range: '7d' }, { dayTrack: true }, 'UTC', NOW);
    expect(d.framed).toBeUndefined();
    expect(d.slots.length).toBe(daySlots(rows, 'UTC').length);
  });
  it('never reads the start of a framed track as everything', () => {
    const d = sliderDomain(rows, { range: '30d' }, {}, 'UTC', NOW);
    expect(rangeFromWindow(d, [0, d.slots.length - 1]).since).not.toBeNull();
  });
});
