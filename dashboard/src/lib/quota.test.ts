import { describe, expect, it } from 'vitest';
import { quotaPace } from './quota';

const H = 3_600_000;
const NOW = Date.parse('2026-11-07T18:00:00Z');
const RESET = NOW + 3 * H;
const r = (hoursAgo: number, used: number, resetAt: number | null = RESET) => ({ at: NOW - hoursAgo * H, used, resetAt });

describe('quota pace', () => {
  it('projects when a fast window fills before its reset', () => {
    const pace = quotaPace([r(1, 40), r(0.5, 50), r(0, 60)], 300, RESET, NOW)!;
    expect(pace.perHour).toBeCloseTo(20);
    expect(pace.fullAt).toBe(NOW + 2 * H);
  });
  it('says a slow window lasts until its reset', () => {
    expect(quotaPace([r(1, 10), r(0, 12)], 300, RESET, NOW)!.fullAt).toBeNull();
  });
  it('ignores readings from before the last reset', () => {
    const pace = quotaPace([r(0.9, 90, RESET - 5 * H), r(0.8, 95, RESET - 5 * H), r(0.5, 2), r(0, 12)], 300, RESET, NOW)!;
    expect(pace.perHour).toBeCloseTo(20);
  });
  it('reads past an older figure reported within the same window', () => {
    const pace = quotaPace([r(1, 40), r(0.6, 52), r(0.5, 49), r(0, 60)], 300, RESET, NOW)!;
    expect(pace.perHour).toBeCloseTo(20);
  });
  it('needs a long enough look at a long window', () => {
    const week = Date.parse('2026-11-12T00:00:00Z');
    expect(quotaPace([r(1, 20, week), r(0, 21, week)], 10080, week, NOW)).toBeNull();
    expect(quotaPace([r(12, 10, week), r(0, 22, week)], 10080, week, NOW)!.perHour).toBeCloseTo(1);
  });
  it('without a reset time, starts after the last large drop', () => {
    const pace = quotaPace([r(0.9, 90, null), r(0.8, 95, null), r(0.5, 2, null), r(0, 12, null)], 300, null, NOW)!;
    expect(pace.perHour).toBeCloseTo(20);
  });
  it('says nothing from readings too close together or too few', () => {
    expect(quotaPace([r(0.1, 10), r(0, 11)], 300, RESET, NOW)).toBeNull();
    expect(quotaPace([r(0, 11)], 300, RESET, NOW)).toBeNull();
  });
  it('reports a flat window as not rising', () => {
    expect(quotaPace([r(1, 30), r(0, 30)], 300, RESET, NOW)).toEqual({ perHour: 0, basisMs: H, fullAt: null });
  });
});
