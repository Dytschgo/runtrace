import { describe, expect, it } from 'vitest';
import { freshness, leftOf, quotaCards, quotaPace, windowLabel, windowName } from './quota';

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

describe('live quota cards', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 1, m)).toISOString();
  const harnessOf = (k: string) => (k === 'claude' ? 'claudeAgent' : k);
  const live = [
    { harness: 'claudeAgent', quota_key: 'claude', checked_at: at(10), reports_limits: true,
      windows: [{ window: 'five_hour', used_percentage: 30, reset_at: at(200), window_minutes: 300 }, { window: 'seven_day_fable', used_percentage: 60, reset_at: at(5000), window_minutes: 10080 }],
      credits: { available: 2, next_expires_at: at(9000), options: [{ label: 'Full reset', description: 'Refills both.', available: 1, expires_at: at(9000) }] } },
    { harness: 'grok', quota_key: 'grok', checked_at: at(9), reports_limits: true, windows: [{ window: 'weekly', used_percentage: 81, reset_at: at(4000), window_minutes: 10080 }], credits: null },
    { harness: 'codex-ollama', quota_key: 'codex-ollama', reports_limits: true, windows: [], unavailable: { reason: 'probeFailed', message: 'Codex could not read usage.' } },
    { harness: 'muse', quota_key: 'muse', reports_limits: false, windows: [] },
    { harness: 'codex-local', quota_key: 'codex-local', reports_limits: true, windows: [], unavailable: { reason: 'local', message: 'Runs models on this machine through Ollama, so it has no limit' } },
    { harness: 'antigravity', quota_key: 'antigravity', checked_at: at(12), checked_by: 'runtrace', plan: null, reports_limits: true,
      windows: [{ window: 'seven_day_claude_and_gpt', label: 'Weekly · Claude and GPT', used_percentage: 25, reset_at: at(6000), window_minutes: 10080 }] },
  ];

  it('takes the windows T3 reports, with the newer of its figure and the agent’s own reading', () => {
    const current = [
      // Claude Code's own reading is older than T3's check, so T3's figure wins.
      { provider: 'claude', window: 'five_hour', used_percentage: 20, reset_at: at(200), sampled_at: at(5), window_minutes: 300 },
      // An old window T3 no longer reports is not shown beside the ones it does.
      { provider: 'claude', window: 'seven_day_opus', used_percentage: 5, reset_at: at(100), sampled_at: at(1) },
      // Codex has no live answer, so its stored reading stands alone, with its plan.
      { provider: 'codex', window: 'weekly', used_percentage: 45, reset_at: at(3000), sampled_at: at(8), plan: 'pro', window_minutes: 10080 },
    ];
    const { cards, silent } = quotaCards(current, live, harnessOf);
    expect(cards.map((c) => c.harness)).toEqual(['claudeAgent', 'grok', 'antigravity', 'codex']);
    expect(cards[0].windows.map((w) => [w.window, w.used])).toEqual([['five_hour', 30], ['seven_day_fable', 60]]);
    expect(cards[0].credits).toMatchObject({ available: 2, options: [{ label: 'Full reset', available: 1 }] });
    expect(cards[0].checkedBy).toBe('t3');
    expect(cards[2]).toMatchObject({ key: 'antigravity', checkedBy: 'runtrace', windows: [{ label: 'Weekly · Claude and GPT', used: 25 }] });
    expect(cards[3]).toMatchObject({ key: 'codex', plan: 'pro', checkedAt: null, checkedBy: null });
    expect(silent).toEqual([
      { harness: 'codex-ollama', why: 'The check failed: Codex could not read usage.', kind: 'failed', plan: null },
      { harness: 'muse', why: 'Nothing checks its limits', kind: 'none', plan: null },
      { harness: 'codex-local', why: 'Runs models on this machine through Ollama, so it has no limit', kind: 'local', plan: null },
    ]);
  });

  it('prefers an agent reading taken after T3 last checked', () => {
    const current = [{ provider: 'grok', window: 'weekly', used_percentage: 83, reset_at: at(4000), sampled_at: at(30) }];
    const grok = quotaCards(current, live, harnessOf).cards.find((c) => c.key === 'grok');
    expect(grok?.windows[0]).toMatchObject({ used: 83, readAt: Date.parse(at(30)) });
  });

  it('names windows the way T3 labels them', () => {
    expect(windowName('five_hour')).toBe('5-hour');
    expect(windowName('seven_day')).toBe('Weekly');
    expect(windowName('seven_day_fable')).toBe('Weekly · Fable');
    expect(windowName('90_minutes')).toBe('90 minutes');
    // A window only the harness can name keeps its own label; the common ones read the same everywhere.
    expect(windowLabel('seven_day_claude_and_gpt', 'Weekly · Claude and GPT')).toBe('Weekly · Claude and GPT');
    expect(windowLabel('five_hour', 'Session')).toBe('5-hour');
  });

  it('turns what was used into what is left, never below nothing', () => {
    expect(leftOf(13)).toBe(87);
    expect(leftOf(104)).toBe(0);
  });

  it('says how fresh a check is', () => {
    const now = Date.parse(at(60));
    expect(freshness(Date.parse(at(55)), now)).toBe('live');
    expect(freshness(Date.parse(at(20)), now)).toBe('recent');
    expect(freshness(now - 2 * 3_600_000, now)).toBe('stale');
    expect(freshness(null, now)).toBe('unknown');
  });
});
