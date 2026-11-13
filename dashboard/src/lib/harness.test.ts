import { describe, expect, it } from 'vitest';
import type { TurnRow } from './entities';
import { balanceByDay, balanceShares, harnessByHour, harnessByProject, harnessColor, harnessName, harnessStats, harnessTotals, limitEpisodes, whoFilter } from './harness';

const turn = (provider: string | null, occurred_at: string, extra: Partial<TurnRow> = {}): TurnRow => ({
  id: `${provider}-${occurred_at}-${Math.random()}`, source_id: '', thread_id: '', run_id: '', project_id: '', instance_id: '', occurred_at, quality: 'exact',
  provider, model: null, resolved: null, status: null, duration: null, input: null, cached: null, output: null, reasoning: null, total: null,
  usage: 'unavailable', scope: null, hasSubagents: null, ...extra,
});

describe('harnesses', () => {
  it('names known harnesses and their variants', () => {
    expect(harnessName('claudeAgent')).toBe('Claude Code');
    expect(harnessName('codex-meta')).toBe('Codex (meta)');
    expect(harnessName('somethingNew')).toBe('SomethingNew');
    expect(harnessName('not-recorded')).toBe('Not recorded');
  });

  it('gives two harnesses from one company different colours, by name alone', () => {
    expect(harnessColor('codex')).not.toBe(harnessColor('codex-meta'));
    expect(harnessColor('gemini')).not.toBe(harnessColor('antigravity'));
    expect(harnessColor('codex-meta')).toBe(harnessColor('codex-meta'));
  });

  it('counts session-log hours as tokens but never as turns', () => {
    const rows = [turn('codex', '2026-11-01T10:00:00Z', { total: 100 }), turn('codex', '2026-11-01T11:00:00Z', { total: 50, log: true })];
    expect(harnessTotals(rows, 'turns')).toEqual([{ key: 'codex', value: 1, turns: 1 }]);
    expect(harnessTotals(rows, 'tokens')).toEqual([{ key: 'codex', value: 150, turns: 1 }]);
  });

  it('balances two harnesses per day and leaves days neither ran empty', () => {
    const rows = [
      turn('claudeAgent', '2026-11-01T10:00:00Z'), turn('claudeAgent', '2026-11-01T11:00:00Z'), turn('codex', '2026-11-01T12:00:00Z'), turn('grok', '2026-11-01T12:00:00Z'),
      turn('grok', '2026-11-02T12:00:00Z'),
      turn('codex', '2026-11-03T12:00:00Z'),
    ];
    const days = balanceByDay(rows, 'claudeAgent', 'codex', 'turns', 'UTC');
    expect(days.map((d) => d.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(days[0].diff).toBeCloseTo(33.33, 1);
    expect(days[1].diff).toBeNull();
    expect(days[2].diff).toBe(-100);
    expect(balanceShares(rows, 'claudeAgent', 'codex', 'turns')).toEqual({ a: 0.5, b: 0.5 });
    const week = balanceByDay(rows, 'claudeAgent', 'codex', 'turns', 'UTC', 7);
    expect(week[1].diff).toBeCloseTo(33.33, 1);
    expect(week[2]).toMatchObject({ a: 2, b: 2, covers: 3, diff: 0 });
  });
});

describe('harness analysis', () => {
  it('splits started from delegated turns by their thread', () => {
    const child = new Set(['helper']);
    const rows = [turn('codex', '2026-11-01T10:00:00Z', { thread_id: 'main' }), turn('codex', '2026-11-01T10:00:00Z', { thread_id: 'helper' })];
    expect(rows.filter(whoFilter('started', child)).map((t) => t.thread_id)).toEqual(['main']);
    expect(rows.filter(whoFilter('delegated', child)).map((t) => t.thread_id)).toEqual(['helper']);
    expect(rows.filter(whoFilter('all', child))).toHaveLength(2);
  });

  it('compares harnesses with medians and leaves what was never reported null', () => {
    const rows = [
      turn('codex', '2026-11-01T10:00:00Z', { total: 100, input: 80, cached: 40, duration: 1000, status: 'completed', model: 'gpt-x', thread_id: 'helper', hasSubagents: true }),
      turn('codex', '2026-11-01T11:00:00Z', { total: 300, input: 20, cached: 10, duration: 3000, status: 'failed', model: 'gpt-x', hasSubagents: false }),
      turn('codex', '2026-11-01T12:00:00Z', { total: 9_000, duration: 5000, status: 'cancelled', model: 'gpt-y' }),
      turn('grok', '2026-11-01T12:00:00Z'),
      turn('codex', '2026-11-01T13:00:00Z', { total: 1, log: true }),
    ];
    const [codex, grok] = harnessStats(rows, new Set(['helper']));
    expect(codex).toMatchObject({ key: 'codex', turns: 3, tokens: 9_400, tokensPerTurn: 300, medianMs: 3000, failed: 1, stopped: 1, statusKnown: 3, delegated: 1, spawned: 1, spawnKnown: 2 });
    expect(codex.cacheShare).toBe(0.5);
    expect(codex.models).toEqual([{ model: 'gpt-x', turns: 2 }, { model: 'gpt-y', turns: 1 }]);
    expect(grok).toMatchObject({ tokens: null, tokensPerTurn: null, cacheShare: null, medianMs: null, statusKnown: 0 });
  });

  it('splits projects and hours by harness', () => {
    const rows = [turn('codex', '2026-11-01T10:00:00Z', { project_id: 'p1' }), turn('claudeAgent', '2026-11-01T10:30:00Z', { project_id: 'p1' }), turn('codex', '2026-11-01T23:00:00Z', { project_id: 'p2' })];
    const projects = harnessByProject(rows, 'turns');
    expect(projects[0]).toMatchObject({ project: 'p1', total: 2 });
    const hours = harnessByHour(rows, 'turns', 'UTC');
    expect(hours[10].values.get('codex')).toBe(1);
    expect(hours[10].values.get('claudeAgent')).toBe(1);
    expect(hours[23].values.get('codex')).toBe(1);
  });

  it('measures the balance while a limit held against the same span before', () => {
    const rows = [
      turn('claudeAgent', '2026-11-01T08:00:00Z'), turn('codex', '2026-11-01T08:30:00Z'),
      turn('codex', '2026-11-01T10:30:00Z'), turn('codex', '2026-11-01T11:00:00Z'),
    ];
    const at = Date.parse('2026-11-01T10:00:00Z');
    const [e] = limitEpisodes([{ provider: 'claude', window: 'five_hour', first_hit_at: '2026-11-01T10:00:00Z', reset_at: '2026-11-01T12:00:00Z', hits: 3 }], rows, 'claudeAgent', 'codex', 'turns', Date.parse('2026-11-02T00:00:00Z'));
    expect(e).toMatchObject({ harness: 'claudeAgent', at, until: at + 2 * 3_600_000, hits: 3, before: 0.5, during: 0 });
  });
});
