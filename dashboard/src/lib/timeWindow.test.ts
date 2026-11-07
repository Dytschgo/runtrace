import { Cpu, Terminal, Wrench } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { ClaudeMark, GeminiMark, GrokMark, MetaMark, OpenAIMark } from '../components/providerMarks';
import { modelIcon, providerIcon, toolIcon } from './icons';
import { assignModelColors, FAMILIES, modelProvider, OTHER_COLOR } from './modelColors';
import { daySlots, endEdge, hourSlots, moveWindow, rangeFromWindow, sliderDomain, startEdge, stepWindow, windowFromFilters, withDraft, zoomRange } from './timeWindow';

const TZ = 'Europe/Zurich';
const HOUR = 3_600_000;
const hours = (iso: string, prompts = 1) => ({ hour: iso, prompts });
const rows = ['2026-10-03T10:00:00Z', '2026-10-04T10:00:00Z', '2026-10-05T10:00:00Z', '2026-10-06T10:00:00Z', '2026-10-07T10:00:00Z'].map((h) => hours(h, 2));
const slots = daySlots(rows, TZ);

describe('daySlots', () => {
  it('keeps one bar per local day, with empty days in place', () => {
    const gappy = daySlots([hours('2026-10-03T10:00:00Z'), hours('2026-10-06T10:00:00Z', 4)], TZ);
    expect(gappy.map((s) => s.key)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
    expect(gappy.map((s) => s.value)).toEqual([1, 0, 0, 4]);
  });
  it('counts a late UTC hour on the local day it belongs to', () => {
    expect(daySlots([hours('2026-10-04T22:30:00Z')], TZ)[0].key).toBe('2026-10-05');
  });
});

describe('hourSlots', () => {
  it('keeps quiet hours, including the current one', () => {
    const from = Date.parse('2026-11-06T10:00:00Z');
    const s = hourSlots([hours('2026-11-06T11:00:00Z', 5)], from, from + 3 * HOUR);
    expect(s.map((x) => x.value)).toEqual([0, 5, 0]);
    expect(s[1].end - s[1].start).toBe(HOUR);
  });
});

describe('sliderDomain', () => {
  const now = Date.parse('2026-11-06T12:30:00Z');
  it('shows the whole history in days by default', () => {
    const d = sliderDomain(rows, {}, {}, TZ, now);
    expect(d).toMatchObject({ unit: 'day', zoomed: false });
    expect(d.slots).toHaveLength(5);
  });
  it('looks at recent hours for a short preset, up to the current hour', () => {
    const d = sliderDomain(rows, { range: '1h' }, {}, TZ, now);
    expect(d.unit).toBe('hour');
    expect(d.slots.at(-1)!.end).toBeGreaterThan(now);
  });
  it('turns bars into hours when zoomed to two weeks or less', () => {
    const d = sliderDomain(rows, {}, { from: '2026-10-04T00:00:00Z', to: '2026-10-05T00:00:00Z' }, TZ, now);
    expect(d).toMatchObject({ unit: 'hour', zoomed: true, openEnd: false });
    expect(d.slots).toHaveLength(24);
  });
  it('stays in days for a longer zoom', () => {
    expect(sliderDomain(rows, {}, { from: '2026-08-01T00:00:00Z', to: '2026-10-05T00:00:00Z' }, TZ, now).unit).toBe('day');
  });
  it('never adds an hour that has not started', () => {
    const d = sliderDomain(rows, { range: '1h' }, {}, TZ, now);
    expect(d.slots.at(-1)!.start).toBeLessThanOrEqual(now);
    expect(d.slots.at(-1)!.end).toBe(Date.parse('2026-11-06T13:00:00Z'));
  });
  it('shows the hours of a short window opened by link', () => {
    const d = sliderDomain(rows, { since: '2026-11-06T04:00:00Z', until: '2026-11-06T04:40:00Z' }, {}, TZ, now);
    expect(d.unit).toBe('hour');
    expect(d.slots.some((s) => s.start === Date.parse('2026-11-06T04:00:00Z'))).toBe(true);
  });
  it('keeps a window dragged on the day track on that track', () => {
    expect(sliderDomain(rows, { since: '2026-10-04T00:00:00Z', until: '2026-10-05T00:00:00Z' }, { dayTrack: true }, TZ, now).unit).toBe('day');
  });
  it('still gives a single day of history a track to move along', () => {
    const d = sliderDomain([hours('2026-10-03T10:00:00Z')], {}, {}, TZ, now);
    expect(d.unit).toBe('hour');
    expect(d.slots.length).toBeGreaterThan(1);
  });
  it('ignores a zoom it cannot read', () => {
    expect(sliderDomain(rows, {}, { from: 'nope', to: 'nope' }, TZ, now).zoomed).toBe(false);
  });
});

describe('windowFromFilters', () => {
  it('spans everything without filters', () => {
    expect(windowFromFilters(slots, {})).toEqual([0, 4]);
  });
  it('reads dates in the display timezone', () => {
    // 22:30 UTC on the 4th is already the 5th in Zurich.
    expect(windowFromFilters(slots, { since: '2026-10-04T22:30:00Z' })).toEqual([2, 4]);
  });
  it('clamps times outside the track', () => {
    expect(windowFromFilters(slots, { since: '2026-01-01T00:00:00Z', until: '2027-01-01T00:00:00Z' })).toEqual([0, 4]);
  });
  it('ignores a date it cannot read rather than failing', () => {
    expect(windowFromFilters(slots, { since: 'not-a-date' })).toEqual([0, 4]);
  });
  it('never lets the end fall before the start', () => {
    expect(windowFromFilters(slots, { since: '2026-10-06T10:00:00Z', until: '2026-10-04T10:00:00Z' })).toEqual([3, 3]);
  });
});

describe('rangeFromWindow', () => {
  const whole = { slots, zoomed: false, openEnd: true, unit: 'day' as const };
  it('treats the full unzoomed span as no filter', () => {
    expect(rangeFromWindow(whole, [0, 4])).toEqual({ since: null, until: null });
  });
  it('leaves a window reaching the latest bar open, so new records join it', () => {
    expect(rangeFromWindow(whole, [2, 4])).toEqual({ since: '2026-10-04T22:00:00.000Z', until: null });
  });
  it('closes on the last millisecond of the end bar', () => {
    expect(rangeFromWindow(whole, [0, 1])).toEqual({ since: null, until: '2026-10-04T21:59:59.999Z' });
  });
  it('keeps the start when zoomed, because the track is no longer the whole history', () => {
    expect(rangeFromWindow({ slots, zoomed: true, openEnd: false, unit: 'day' }, [0, 4]).since).toBe(new Date(slots[0].start).toISOString());
    expect(rangeFromWindow({ slots, zoomed: true, openEnd: false, unit: 'day' }, [0, 4]).until).not.toBeNull();
  });
  it('keeps the start on an hour track, because its first bar is not the start of history', () => {
    expect(rangeFromWindow({ slots, zoomed: false, openEnd: true, unit: 'hour' }, [0, 4]).since).toBe(new Date(slots[0].start).toISOString());
  });
  it('round-trips through the filters', () => {
    const { since, until } = rangeFromWindow(whole, [1, 3]);
    expect(windowFromFilters(slots, { since: since!, until: until! })).toEqual([1, 3]);
  });
});

describe('stepWindow', () => {
  const now = Date.parse('2026-11-06T12:30:00Z');
  const start = Date.parse('2026-11-06T11:30:00Z');
  it('goes to the hour before, keeping its exact length', () => {
    const s = stepWindow(start, null, -1, now);
    expect(s.since).toBe('2026-11-06T10:30:00.000Z');
    expect(s.until).toBe('2026-11-06T11:29:59.999Z');
  });
  it('uses a preset length as given, not the time since its rounded start', () => {
    const rounded = Date.parse('2026-11-06T11:27:00Z');
    const s = stepWindow(rounded, null, -1, now, 3_600_000);
    expect(Date.parse(s.until!) + 1 - Date.parse(s.since)).toBe(3_600_000);
    expect(s.until).toBe('2026-11-06T11:26:59.999Z');
  });
  it('lands back exactly after stepping back then forward', () => {
    const a = Date.parse('2026-11-05T20:00:00Z');
    const b = Date.parse('2026-11-05T21:00:00Z');
    const back = stepWindow(a, b, -1, now);
    const forward = stepWindow(Date.parse(back.since), Date.parse(back.until!) + 1, 1, now);
    expect(forward.since).toBe(new Date(a).toISOString());
    expect(Date.parse(forward.until!) + 1).toBe(b);
  });
  it('comes back forward, and reopens the window on reaching now', () => {
    const back = stepWindow(Date.parse('2026-11-06T10:30:00Z'), Date.parse('2026-11-06T11:30:00Z'), 1, now);
    expect(back.since).toBe('2026-11-06T11:30:00.000Z');
    expect(back.until).toBeNull();
  });
  it('reopens when it lands just short of now, because time passed since the step back', () => {
    const later = now + 90_000;
    expect(stepWindow(Date.parse('2026-11-06T10:30:00Z'), Date.parse('2026-11-06T11:30:00Z'), 1, later).until).toBeNull();
  });
  it('gives short windows an hour track that never passes the current hour', () => {
    const s = stepWindow(start, null, -1, now);
    expect(Date.parse(s.track!.ze)).toBeLessThanOrEqual(Date.parse('2026-11-06T13:00:00Z'));
    expect(stepWindow(start - 20 * 86_400_000, null, -1, now).track).toBeNull();
  });
});

describe('zoomRange', () => {
  it('never reaches past the hour we are in', () => {
    const now = Date.parse('2026-11-06T12:30:00Z');
    const z = zoomRange(now - HOUR, now + HOUR, 6 * HOUR, now);
    expect(z.to).toBe(Date.parse('2026-11-06T13:00:00Z'));
    expect(z.to - z.from).toBe(6 * HOUR);
  });
  it('keeps a wide window as it is', () => {
    expect(zoomRange(0, 10 * HOUR)).toEqual({ from: 0, to: 10 * HOUR });
  });
  it('widens a tiny window around its middle, so there are bars to drag', () => {
    const z = zoomRange(100 * HOUR, 101 * HOUR);
    expect(z.to - z.from).toBe(6 * HOUR);
    expect(z.from).toBeLessThan(100 * HOUR);
    expect(z.to).toBeGreaterThan(101 * HOUR);
  });
});

describe('moveWindow', () => {
  it('stops a handle at the other handle, so a window keeps at least one bar', () => {
    expect(moveWindow([1, 3], 'start', 9, 5)).toEqual([3, 3]);
    expect(moveWindow([1, 3], 'end', -2, 5)).toEqual([1, 1]);
  });
  it('stops at the ends of the track', () => {
    expect(moveWindow([1, 3], 'start', -4, 5)).toEqual([0, 3]);
    expect(moveWindow([1, 3], 'end', 40, 5)).toEqual([1, 4]);
  });
  it('carries the whole window without changing its length', () => {
    expect(moveWindow([1, 3], 'both', 2, 5)).toEqual([2, 4]);
    expect(moveWindow([1, 3], 'both', 4, 5)).toEqual([2, 4]);
    expect(moveWindow([1, 3], 'both', -1, 5)).toEqual([0, 2]);
  });
});

it('places handles on the edges of bars, so one selected bar stays visible', () => {
  expect(startEdge(0, 5)).toBe(0);
  expect(endEdge(4, 5)).toBe(100);
  expect(endEdge(2, 5) - startEdge(2, 5)).toBe(20);
});

describe('withDraft', () => {
  const f = { range: '7d', since: 'a', project: 'p' };
  it('leaves the filters alone without a draft', () => {
    expect(withDraft(f, null)).toBe(f);
  });
  it('replaces the time and the preset, and keeps the scope', () => {
    expect(withDraft(f, { since: 'b', until: null })).toEqual({ since: 'b', until: undefined, range: undefined, project: 'p' });
  });
});

describe('icons', () => {
  it('shows the logo of the provider that served a model', () => {
    expect(modelIcon('gpt-6.1-sol')).toBe(OpenAIMark);
    expect(modelIcon('gpt-6-luna')).toBe(OpenAIMark);
    expect(modelIcon('claude-opus-5-5')).toBe(ClaudeMark);
    expect(modelIcon('grok-4.7-build-fast')).toBe(GrokMark);
    expect(modelIcon('muse-spark-1.3')).toBe(MetaMark);
    expect(modelIcon('gemini-pro-agent')).toBe(GeminiMark);
    expect(providerIcon('anthropic')).toBe(ClaudeMark);
  });
  it('falls back for an unknown or missing model', () => {
    expect(modelIcon('something-new')).toBe(Cpu);
    expect(modelIcon(null)).toBe(Cpu);
  });
  it('matches tools by what they do', () => {
    expect(toolIcon('command_execution')).toBe(Terminal);
    expect(toolIcon('mystery')).toBe(Wrench);
    expect(toolIcon(undefined)).toBe(Wrench);
  });
});

describe('model colours', () => {
  const colors = assignModelColors(['gpt-6.1-sol', 'claude-opus-5-5', 'gpt-6-luna', 'claude-fable-5-1', 'grok-4.7', 'gpt-6-astra']);
  it('uses each company colour as the top of its scale', () => {
    expect(FAMILIES.openai[0]).toBe('#ffffff');
    expect(colors.get('claude-opus-5-5')).toBe(FAMILIES.anthropic[0]);
    expect(colors.get('grok-4.7')).toBe(FAMILIES.xai[0]);
  });
  it('makes every OpenAI step a true gray', () => {
    for (const c of FAMILIES.openai) expect(new Set([c.slice(1, 3), c.slice(3, 5), c.slice(5, 7)]).size).toBe(1);
  });
  it('keeps every model of a provider on that provider scale', () => {
    for (const [model, color] of colors) expect(FAMILIES[modelProvider(model)]).toContain(color);
  });
  it('gives the steps out busiest first', () => {
    expect(colors.get('gpt-6.1-sol')).toBe(FAMILIES.openai[0]);
    expect(colors.get('gpt-6-luna')).toBe(FAMILIES.openai[1]);
    expect(colors.get('gpt-6-astra')).toBe(FAMILIES.openai[2]);
    expect(colors.get('claude-fable-5-1')).toBe(FAMILIES.anthropic[1]);
  });
  it('never reuses the top colour, even past the end of a scale', () => {
    const many = Array.from({ length: FAMILIES.openai.length * 3 }, (_, i) => `gpt-${i}`);
    const colors = assignModelColors(many);
    many.slice(1).forEach((m) => expect(colors.get(m)).not.toBe(FAMILIES.openai[0]));
  });
  it('keeps an unknown model off the company scales and away from the gray Other', () => {
    const c = assignModelColors(['mystery-1']).get('mystery-1');
    expect(FAMILIES.openai).not.toContain(c);
    expect(c).not.toBe(OTHER_COLOR);
  });
});
