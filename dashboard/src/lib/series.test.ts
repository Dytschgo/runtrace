import { describe, expect, it } from 'vitest';
import type { TurnRow } from './entities';
import { assignModelColors, FAMILIES } from './modelColors';
import { autoResolution, buildTrace, effectiveResolution, metricValue, projectColor, turnProvider, type TraceInput } from './series';

const TZ = 'Europe/Zurich';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const turn = (over: Partial<TurnRow>): TurnRow => ({
  id: 'x', source_id: 'x', thread_id: 't', run_id: 'r', project_id: 'p1', instance_id: 'local', occurred_at: '2026-11-06T10:00:00Z', quality: 'partial',
  provider: 'codex', model: 'gpt-6.1-sol', resolved: null, status: 'completed', duration: 1, cacheWrite: 0,
  input: 100, cached: 80, output: 10, reasoning: 2, total: 110, usage: 'complete', scope: 'main_agent', hasSubagents: false, ...over,
});
const base = (turns: TurnRow[], over: Partial<TraceInput> = {}): TraceInput => ({
  turns, by: 'model', metric: 'total', res: '1h', tz: TZ,
  since: Date.parse('2026-11-06T09:00:00Z'), until: Date.parse('2026-11-06T12:59:59Z'),
  modelColors: assignModelColors(['gpt-6.1-sol', 'claude-opus-5-5', 'gpt-6-luna']), projectName: (id) => (id === 'p1' ? 'Runtrace' : null), ...over,
});
const sum = (rows: ReturnType<typeof buildTrace>['rows'], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

describe('metricValue', () => {
  it('reads each token type', () => {
    const t = turn({ input: 100, cached: 70, cacheWrite: 10, output: 5, reasoning: 1, total: 105 });
    expect(metricValue(t, 'total')).toBe(105);
    expect(metricValue(t, 'cached')).toBe(70);
    expect(metricValue(t, 'cacheWrite')).toBe(10);
    expect(metricValue(t, 'output')).toBe(5);
    expect(metricValue(t, 'reasoning')).toBe(1);
    expect(metricValue(t, 'turns')).toBe(1);
  });
  it('takes the cache out of uncached input', () => {
    expect(metricValue(turn({ input: 100, cached: 70, cacheWrite: 10 }), 'input')).toBe(20);
  });
  it('never drops below zero when a provider counts cache separately', () => {
    expect(metricValue(turn({ input: 5, cached: 70, cacheWrite: 10 }), 'input')).toBe(0);
  });
  it('leaves an unreported field null, never zero', () => {
    const t = turn({ input: null, cached: null, cacheWrite: null, output: null, total: null, reasoning: null });
    for (const m of ['total', 'input', 'cached', 'cacheWrite', 'output', 'reasoning'] as const) expect(metricValue(t, m)).toBeNull();
    expect(metricValue(t, 'turns')).toBe(1);
  });
});

describe('resolution', () => {
  it('chooses finer bars for shorter windows', () => {
    expect(autoResolution(HOUR)).toBe('5m');
    expect(autoResolution(6 * HOUR)).toBe('15m');
    expect(autoResolution(DAY)).toBe('1h');
    expect(autoResolution(7 * DAY)).toBe('6h');
    expect(autoResolution(35 * DAY)).toBe('1d');
    expect(autoResolution(200 * DAY)).toBe('1w');
  });
  it('honours a request that fits, and steps up one that would draw too many points', () => {
    expect(effectiveResolution('1h', 7 * DAY)).toBe('1h');
    expect(effectiveResolution('5m', 35 * DAY)).toBe('6h');
    expect(effectiveResolution('auto', DAY)).toBe('1h');
  });
});

describe('turnProvider', () => {
  it('trusts the model name first', () => {
    expect(turnProvider({ model: 'claude-opus-5-5', provider: 'codex' })).toBe('anthropic');
  });
  it('credits a turn with no recorded model to the agent that ran it', () => {
    expect(turnProvider({ model: null, provider: 'codex' })).toBe('openai');
    expect(turnProvider({ model: null, provider: 'claudeAgent' })).toBe('anthropic');
    expect(turnProvider({ model: null, provider: 'muse' })).toBe('meta');
  });
  it('says nothing when neither is known', () => {
    expect(turnProvider({ model: null, provider: null })).toBeNull();
  });
});

describe('buildTrace', () => {
  const turns = [
    turn({ occurred_at: '2026-11-06T09:10:00Z', total: 100 }),
    turn({ occurred_at: '2026-11-06T09:50:00Z', total: 50 }),
    turn({ occurred_at: '2026-11-06T11:00:00Z', model: 'claude-opus-5-5', provider: 'claudeAgent', total: 40 }),
    turn({ occurred_at: '2026-11-06T11:30:00Z', model: 'gpt-6-luna', total: 10 }),
    turn({ occurred_at: '2026-11-06T08:00:00Z', total: 9999 }),
  ];
  it('leaves out anything outside the window', () => {
    expect(buildTrace(base(turns)).total).toBe(200);
  });
  it('keeps empty buckets so spacing is true to time', () => {
    const { rows } = buildTrace(base(turns));
    expect(rows).toHaveLength(4);
    expect(Number(rows[1]['gpt-6.1-sol'] ?? 0)).toBe(0);
  });
  it('sums into the right bucket and agrees with the list', () => {
    const t = buildTrace(base(turns));
    expect(t.rows[0]['gpt-6.1-sol']).toBe(150);
    expect(t.lines[0]).toMatchObject({ key: 'gpt-6.1-sol', value: 150, turns: 2 });
    expect(sum(t.rows, 'gpt-6.1-sol')).toBe(t.lines[0].value);
  });
  it('merges models into their provider, in the company colour', () => {
    const t = buildTrace(base(turns, { by: 'provider' }));
    const openai = t.lines.find((l) => l.key === 'openai')!;
    expect(openai.value).toBe(160);
    expect(openai.info).toMatchObject({ label: 'OpenAI', color: FAMILIES.openai[0] });
    expect(t.lines.find((l) => l.key === 'anthropic')?.info.color).toBe(FAMILIES.anthropic[0]);
    expect(t.total).toBe(200);
  });
  it('gives a turn with no model to its provider in that view, and calls it not recorded in the model view', () => {
    const t = [turn({ model: null, provider: 'codex', total: 7 })];
    expect(buildTrace(base(t, { by: 'provider' })).lines[0].key).toBe('openai');
    expect(buildTrace(base(t)).lines[0]).toMatchObject({ key: 'not-recorded' });
  });
  it('groups by project with its name', () => {
    expect(buildTrace(base(turns, { by: 'project' })).lines[0].info.label).toBe('Runtrace');
  });
  it('says so plainly when a project is not imported', () => {
    expect(buildTrace(base([turn({ project_id: 'gone' })], { by: 'project' })).lines[0].info.label).toBe('Project not imported');
  });
  it('switches measure', () => {
    expect(buildTrace(base(turns, { metric: 'turns' })).total).toBe(4);
    expect(buildTrace(base(turns, { metric: 'output' })).total).toBe(40);
  });
  it('totals null, not zero, when nobody reported the measure', () => {
    const t = buildTrace(base([turn({ total: null })]));
    expect(t.total).toBeNull();
    expect(t.lines[0]).toMatchObject({ value: 0, reported: 0, turns: 1 });
    expect(t.series).toHaveLength(0);
  });
  it('folds lines past the limit into one dashed Other, keeping the total', () => {
    const many = Array.from({ length: 5 }, (_, i) => turn({ model: `m${i}`, provider: null, total: 10 - i }));
    const t = buildTrace(base(many, { limit: 2 }));
    expect(t.series.map((s) => s.key)).toEqual(['m0', 'm1', 'Other']);
    expect(t.series[2].dash).toBe(true);
    expect(sum(t.rows, 'Other')).toBe(8 + 7 + 6);
    expect(t.total).toBe(40);
  });
  it('runs a total forward in cumulative mode', () => {
    const { rows } = buildTrace(base(turns, { cumulative: true }));
    expect(rows.map((r) => Number(r['gpt-6.1-sol']))).toEqual([150, 150, 150, 150]);
  });
  it('labels sub-day buckets with the clock, in the display timezone', () => {
    expect(buildTrace(base(turns)).rows[0].tick).toBe('10:00');
  });
  it('splits local days at local midnight', () => {
    const late = [turn({ occurred_at: '2026-11-05T23:30:00Z', total: 3 })];
    const t = buildTrace(base(late, { res: '1d', since: Date.parse('2026-11-05T12:00:00Z'), until: Date.parse('2026-11-06T12:00:00Z') }));
    // 23:30 UTC on the 5th is already the 6th in Zurich.
    const hit = t.rows.find((r) => r['gpt-6.1-sol']);
    expect(hit?.tick).toBe('6 NOV');
  });
  it('anchors 6h buckets to the local clock', () => {
    const t = buildTrace(base([turn({ occurred_at: '2026-11-06T10:30:00Z' })], { res: '6h' }));
    // 11:30 in Zurich falls in the bucket that starts at 06:00.
    expect(t.rows[0].tick).toBe('06:00');
  });
  it('loses nothing across a clock change, at every resolution, in every zone', () => {
    // Europe/Zurich gains an hour on 25 Oct 2026, and America/New_York on 1 Nov 2026.
    const spread = (from: string, n: number, gap: number) => Array.from({ length: n }, (_, i) => turn({ occurred_at: new Date(Date.parse(from) + i * gap).toISOString(), total: 1 }));
    const long = spread('2026-10-20T00:00:00Z', 800, 45 * MIN);
    const short = spread('2026-10-24T12:00:00Z', 300, 20 * MIN);
    for (const tz of ['Europe/Zurich', 'America/New_York', 'Asia/Kolkata', 'UTC']) {
      for (const res of ['1h', '6h', '1d', '1w'] as const) {
        const t = buildTrace(base(long, { tz, res, since: Date.parse('2026-10-20T00:00:00Z'), until: Date.parse('2026-11-20T00:00:00Z') }));
        expect(sum(t.rows, 'gpt-6.1-sol'), `${tz} ${res}`).toBe(800);
      }
      for (const res of ['5m', '15m'] as const) {
        const t = buildTrace(base(short, { tz, res, since: Date.parse('2026-10-24T12:00:00Z'), until: Date.parse('2026-10-29T00:00:00Z') }));
        expect(sum(t.rows, 'gpt-6.1-sol'), `${tz} ${res}`).toBe(300);
      }
    }
    // America/New_York changes on 1 Nov, so its 15 minute rows must cross that too.
    const ny = spread('2026-10-31T12:00:00Z', 200, 20 * MIN);
    const t = buildTrace(base(ny, { tz: 'America/New_York', res: '15m', since: Date.parse('2026-10-31T12:00:00Z'), until: Date.parse('2026-11-04T00:00:00Z') }));
    expect(sum(t.rows, 'gpt-6.1-sol')).toBe(200);
  });
  it('marks a group that ran but reported nothing, separately from one that did not run', () => {
    const t = buildTrace(base([
      turn({ occurred_at: '2026-11-06T09:10:00Z', total: null }),
      turn({ occurred_at: '2026-11-06T10:10:00Z', total: 5 }),
    ]));
    expect(t.gaps.get(0)).toEqual(new Set(['gpt-6.1-sol']));
    expect(t.gaps.has(1)).toBe(false);
    expect(t.gaps.has(2)).toBe(false);
    expect(t.total).toBe(5);
  });
  it('does not call a bucket missing when another turn there did report', () => {
    const t = buildTrace(base([turn({ occurred_at: '2026-11-06T09:10:00Z', total: null }), turn({ occurred_at: '2026-11-06T09:20:00Z', total: 5 })]));
    expect(t.gaps.size).toBe(0);
  });
  it('tells partial usage apart from no usage', () => {
    const none = buildTrace(base([turn({ input: null, cached: null, cacheWrite: null, output: null, reasoning: null, total: null })]));
    const some = buildTrace(base([turn({ total: null })]));
    expect(none.lines[0].partial).toBe(false);
    expect(some.lines[0].partial).toBe(true);
  });
  it('keeps a project colour when the window moves, and avoids company colours', () => {
    const turns = [turn({ project_id: 'alpha', total: 100 }), turn({ project_id: 'beta', total: 10, occurred_at: '2026-11-06T11:00:00Z' })];
    expect(projectColor('alpha')).not.toBe(FAMILIES.openai[0]);
    const narrow = buildTrace(base(turns, { by: 'project', since: Date.parse('2026-11-06T10:30:00Z') }));
    expect(narrow.lines[0].info.color).toBe(projectColor('beta'));
  });
  it('never changes a project colour, whatever else is on the chart', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const first = ids[0];
    const rival = ids.find((id) => id !== first && projectColor(id) === projectColor(first))!;
    const free = ids.find((id) => id !== first && id !== rival && projectColor(id) !== projectColor(first))!;
    const lines = (totals: Record<string, number>) => new Map(buildTrace(base(Object.entries(totals).map(([project_id, total]) => turn({ project_id, total })), { by: 'project' })).series.map((s) => [s.key, s]));
    const full = lines({ [first]: 10, [rival]: 5, [free]: 1 });
    for (const id of [first, rival, free]) expect(full.get(id)!.color).toBe(projectColor(id));
    expect(lines({ [rival]: 5 }).get(rival)!.color).toBe(projectColor(rival));
    expect(lines({ [first]: 1, [rival]: 5, [free]: 10 }).get(rival)!.color).toBe(projectColor(rival));
    // The two sharing a colour still differ, by the dash of the later id, and the one alone is solid.
    const [a, b] = [first, rival].sort();
    expect(full.get(a)!.dashArray).toBeUndefined();
    expect(full.get(b)!.dashArray).toBeTruthy();
    expect(lines({ [rival]: 5 }).get(rival)!.dashArray).toBeUndefined();
  });
  it('keeps a running total a lower bound once anything is missing, and keeps what it had', () => {
    const t = buildTrace(base([
      turn({ occurred_at: '2026-11-06T09:10:00Z', total: 10 }),
      turn({ occurred_at: '2026-11-06T10:10:00Z', total: null }),
      turn({ occurred_at: '2026-11-06T11:10:00Z', total: 5 }),
    ], { cumulative: true }));
    const key = t.series[0].key;
    expect(t.rows.map((r) => r[key])).toEqual([10, 10, 15, 15]);
    expect(t.partials.get(0)).toBeUndefined();
    expect(t.gaps.get(1)?.has(key)).toBeFalsy();
    for (const i of [1, 2, 3]) expect(t.partials.get(i)?.has(key)).toBe(true);
  });
  it('leaves a running total missing until something has been measured', () => {
    const t = buildTrace(base([
      turn({ occurred_at: '2026-11-06T09:10:00Z', total: null }),
      turn({ occurred_at: '2026-11-06T11:10:00Z', total: 5 }),
    ], { cumulative: true }));
    const key = t.series[0].key;
    expect(t.gaps.get(0)?.has(key)).toBe(true);
    expect(t.gaps.get(1)?.has(key)).toBe(true);
    expect(t.partials.get(2)?.has(key)).toBe(true);
  });
  it('keeps every turn in weekly buckets across a clock change midweek', () => {
    const turns = Array.from({ length: 20 }, (_, d) => turn({ id: `t${d}`, occurred_at: new Date(Date.parse('2026-10-15T12:00:00Z') + d * DAY).toISOString(), total: 1 }));
    for (const tz of ['Africa/Cairo', 'Europe/Zurich', 'America/New_York', 'Pacific/Auckland']) {
      const t = buildTrace(base(turns, { metric: 'turns', res: '1w', tz, since: Date.parse('2026-10-15T00:00:00Z'), until: Date.parse('2026-11-04T23:00:00Z') }));
      expect(t.rows.reduce((s, r) => s + t.series.reduce((x, g) => x + Number(r[g.key] ?? 0), 0), 0), tz).toBe(20);
    }
  });
  it('always finishes, however many projects there are', () => {
    const many = Array.from({ length: 40 }, (_, i) => turn({ project_id: `project-${i}`, total: 100 - i }));
    const t = buildTrace(base(many, { by: 'project', limit: 500 }));
    expect(t.lines).toHaveLength(40);
    expect(t.total).toBe(many.reduce((s, x) => s + (x.total ?? 0), 0));
  });
  it('keeps a group silent in a comparison even when it has no line of its own', () => {
    const t = buildTrace(base([turn({ model: 'grok-4.7', total: null, occurred_at: '2026-11-06T09:10:00Z' })]));
    expect(t.silentGroups.get(0)).toEqual(new Set(['grok-4.7']));
  });
  it('adds no row for a bucket that has not started', () => {
    const t = buildTrace(base([turn({ occurred_at: '2026-11-06T09:10:00Z', total: 1 })], { res: '1h', until: Date.parse('2026-11-06T11:00:00Z') }));
    expect(t.rows.at(-1)!.t).toBeLessThan(Date.parse('2026-11-06T11:00:00Z'));
  });
  it('knows the total of a window that holds only session-log hours', () => {
    const t = buildTrace(base([turn({ id: 'a', total: 40, log: true }), turn({ id: 'b', total: 60, log: true })]));
    expect(t.total).toBe(100);
    expect(t.turns).toBe(0);
    expect(t.records).toBe(2);
    const full = buildTrace(base([turn({ id: 'a', total: 40, log: true })], { totalsOnly: true }));
    expect(full.total).toBe(40);
  });
  it('adds session-log hours to the tokens but never counts them as turns', () => {
    const t = buildTrace(base([turn({ total: 10 }), turn({ id: 'log', total: 90, log: true })]));
    expect(t.total).toBe(100);
    expect(t.turns).toBe(1);
    expect(t.records).toBe(2);
    expect(t.lines[0].turns).toBe(1);
    expect(t.lines[0].reported).toBe(1);
    const turns = buildTrace(base([turn({ total: 10 }), turn({ id: 'log', total: 90, log: true })], { metric: 'turns' }));
    expect(turns.total).toBe(1);
  });
  it('never draws two projects alike', () => {
    const many = Array.from({ length: 8 }, (_, i) => turn({ project_id: `project-${i * 8}`, total: 100 - i }));
    const looks = buildTrace(base(many, { by: 'project' })).series.map((s) => `${s.color}|${s.dashArray ?? ''}`);
    expect(new Set(looks).size).toBe(looks.length);
  });
  it('treats a bucket where only some turns reported as a lower bound', () => {
    const t = buildTrace(base([turn({ occurred_at: '2026-11-06T09:10:00Z', total: null }), turn({ occurred_at: '2026-11-06T09:20:00Z', total: 5 })]));
    expect(t.partials.get(0)).toEqual(new Set(['gpt-6.1-sol']));
    expect(t.gaps.size).toBe(0);
  });
  it('names a group that ran and reported nothing even when it has no line', () => {
    const t = buildTrace(base([turn({ model: 'grok-4.7', total: null, occurred_at: '2026-11-06T09:10:00Z' }), turn({ occurred_at: '2026-11-06T10:10:00Z', total: 5 })]));
    expect(t.unreported.get(0)).toEqual(['grok-4.7']);
    expect(t.series.map((s) => s.key)).toEqual(['gpt-6.1-sol']);
  });
  it('dashes the not-recorded line so it is never read as a gray model', () => {
    expect(buildTrace(base([turn({ model: null, provider: null })])).lines[0].info.dash).toBe(true);
  });
  it('stays safe with no turns at all', () => {
    const t = buildTrace(base([]));
    expect(t).toMatchObject({ total: null, lines: [], series: [] });
    expect(t.rows.length).toBeGreaterThan(0);
  });
});

describe('models sharing a shade', () => {
  it('dash the one ranked later of all time, so no two drawn lines look the same', () => {
    const names = ['claude-a', 'claude-b', 'claude-c', 'claude-d', 'claude-e', 'claude-f', 'claude-g'];
    const colors = assignModelColors(names);
    const t = buildTrace(base(names.map((m, i) => turn({ id: m, model: m, provider: 'claudeAgent', total: 100 - i })), { modelColors: colors, limit: 64 }));
    const seen = new Set<string>();
    for (const s of t.series) {
      const look = `${s.color}|${s.dashArray ?? ''}`;
      expect(seen.has(look)).toBe(false);
      seen.add(look);
    }
    expect(t.series.find((s) => s.key === 'claude-a')!.dashArray).toBeUndefined();
  });
});
