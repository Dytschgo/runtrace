import { describe, expect, it } from 'vitest';
import { bucketActivity, buildHeatmap, coverageRows, delta, percentile, redactionTotals, stackByDay, tokensByKey, tokenSummary, toolStats, toolSummary, usageByProvider, captureGaps } from './analytics';
import { ApiError, getEntities, getJson, scanHourly, scanPages, toCsv } from './api';
import { commandPreview, durationMs, parseContent, readCutField, toAgent, toThread, toTool, toTurn, type ThreadRow, type ToolRow } from './entities';
import { apiParams, inTimeRange, previousWindow, resolveFilters } from './filters';
import { providerFromThread } from './entities';
import { cleanText, fmtDuration, fmtPct, fmtRelative, localParts, repairText, snippet, zonedDayStart } from './format';
import type { Entity } from './types';
import { applyPatch, pageSearch, resolvePage } from './url';
import { vi } from 'vitest';

const entity = (data: Record<string, unknown>, extra: Partial<Entity> = {}): Entity => ({
  id: 'id', source_id: 'src', kind: 'thread', instance_id: 'local', project_id: 'p', thread_id: 't', run_id: 'r', occurred_at: '2026-11-05T10:00:00Z', data, ...extra,
});

describe('format', () => {
  it('repairs Windows-1252 mojibake and leaves real text alone', () => {
    expect(repairText('JRI ship Â· Luna')).toBe('JRI ship · Luna');
    expect(repairText('serverâ€™s lease')).toBe('server’s lease');
    expect(repairText('Arbeitsfassung prüfen · café')).toBe('Arbeitsfassung prüfen · café');
  });
  it('strips terminal control codes from captured text', () => {
    expect(cleanText('Output\u001b[K\r\n\n\n\n\u001b[32mdone\u001b[0m')).toBe('Output\n\ndone');
  });
  it('formats durations and treats unknown as a dash, never zero', () => {
    expect(fmtDuration(420)).toBe('420 ms');
    expect(fmtDuration(3200)).toBe('3.2 s');
    expect(fmtDuration(252_000)).toBe('4m 12s');
    expect(fmtDuration(7_500_000)).toBe('2h 05m');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(0)).toBe('0 ms');
  });
  it('labels small shares without rounding them to zero', () => {
    expect(fmtPct(0.004)).toBe('<1%');
    expect(fmtPct(0)).toBe('0%');
  });
  it('reads calendar parts in the display timezone', () => {
    expect(localParts('2026-10-30T23:00:00Z', 'Europe/Zurich')).toEqual({ date: '2026-10-31', hour: 0, weekday: 5 });
    expect(localParts('2026-10-30T23:00:00Z', 'UTC')).toEqual({ date: '2026-10-30', hour: 23, weekday: 4 });
  });
  it('finds local midnight across the daylight saving change', () => {
    expect(zonedDayStart('2026-07-01', 'Europe/Zurich').toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(zonedDayStart('2026-11-06', 'Europe/Zurich').toISOString()).toBe('2026-11-05T23:00:00.000Z');
  });
  it('describes age and refuses to guess when a date is invalid', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    expect(fmtRelative('2026-11-06T11:30:00Z', now)).toBe('30m ago');
    expect(fmtRelative('nonsense', now)).toBe('unknown');
  });
  it('centres a search snippet on the match', () => {
    const s = snippet(`${'a'.repeat(200)}Needle${'b'.repeat(200)}`, 'needle', 10);
    expect(s.match).toBe('Needle');
    expect(s.before).toBe(`…${'a'.repeat(10)}`);
    expect(s.after).toBe(`${'b'.repeat(10)}…`);
  });
});

describe('entities', () => {
  it('derives duration only from valid times and prefers a backend value', () => {
    expect(durationMs({ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:05Z' })).toBe(5000);
    expect(durationMs({ started_at: '2026-01-01T00:00:00Z', completed_at: null })).toBeNull();
    expect(durationMs({ started_at: '2026-01-01T00:00:05Z', completed_at: '2026-01-01T00:00:00Z' })).toBeNull();
    expect(durationMs({ duration_ms: 42, started_at: '2026-01-01T00:00:00Z' })).toBe(42);
  });
  it('keeps token usage unknown when it is null or absent', () => {
    expect(toThread(entity({ token_usage: null })).tokens).toBeNull();
    expect(toThread(entity({})).tokens).toBeNull();
    expect(toThread(entity({ token_usage: { total_tokens: 12 } })).tokens).toBe(12);
    expect(toThread(entity({ token_usage: 0 })).tokens).toBe(0);
  });
  it('tolerates entity rows with missing fields', () => {
    const t = toThread(entity({}));
    expect(t).toMatchObject({ title: 'Untitled thread', type: 'unknown', parent: null, depth: null, model: null });
    const a = toAgent(entity({}, { kind: 'agent' }));
    expect(a).toMatchObject({ child: null, returned: null, duration: null, task: null });
    expect(toTool(entity({}, { kind: 'tool' }))).toMatchObject({ name: 'unknown', category: 'unknown', status: null, exit: null, chars: null });
  });
  it('distinguishes a false delivery state from an unrecorded one', () => {
    expect(toAgent(entity({ result_returned_to_parent: false })).returned).toBe(false);
    expect(toAgent(entity({ result_returned_to_parent: null })).returned).toBeNull();
  });
  it('shows content that redaction left as invalid JSON instead of dropping it', () => {
    expect(parseContent({ content_redacted: '{"arguments":"x","result":"y"}' }).fields).toEqual({ arguments: 'x', result: 'y' });
    expect(parseContent({ content_redacted: '{"arguments":"x[REDACTED' })).toEqual({ fields: null, raw: '{"arguments":"x[REDACTED', truncated: false });
    expect(parseContent({}).raw).toBeNull();
  });
  it('reads fields from a preview that was cut mid-string', () => {
    const cut = '{"result":null,"task":"Line one\\nline \\"two\\" and more te\\';
    expect(readCutField(cut, 'task')).toBe('Line one\nline "two" and more te');
    expect(readCutField(cut, 'diff')).toBeNull();
    expect(parseContent({ content_redacted: cut, content_truncated: true }).fields).toEqual({ task: 'Line one\nline "two" and more te' });
    expect(toAgent(entity({ content_redacted: cut, content_truncated: true })).task).toBe('Line one\nline "two" and more te');
  });
  it('builds a tool preview from a cut record', () => {
    const t = toTool(entity({ content_redacted: '{"arguments":null,"diff":"+ added line\\n- gone', content_truncated: true, model: 'm-1' }));
    expect(t.preview).toBe('+ added line - gone');
    expect(t.model).toBe('m-1');
  });
  it('keeps provider turn usage null when unreported, and reports it when present', () => {
    const none = toTurn(entity({ provider: 'grok', usage_status: 'unavailable', input_tokens: null, total_tokens: null, requested_model: 'grok-4.7', duration_ms: 5 }));
    expect(none).toMatchObject({ provider: 'grok', model: 'grok-4.7', total: null, input: null, usage: 'unavailable', duration: 5 });
    const some = toTurn(entity({ model: 'gpt', input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12, usage_status: 'complete' }));
    expect(some).toMatchObject({ model: 'gpt', input: 10, cached: 0, total: 12, usage: 'complete' });
    expect(toTurn(entity({})).usage).toBe('unavailable');
  });
  it('previews the command inside a shell wrapper', () => {
    expect(commandPreview('"pwsh.exe" -Command "git status --short"')).toBe('git status --short"');
    expect(commandPreview('rg -n foo')).toBe('rg -n foo');
  });
  it('previews a diff when a tool has no arguments, and keeps the preview short', () => {
    const t = toTool(entity({ content_redacted: JSON.stringify({ arguments: null, diff: `+ ${'x'.repeat(500)}`, result: null }) }));
    expect(t.preview.startsWith('+ x')).toBe(true);
    expect(t.preview.length).toBeLessThanOrEqual(160);
  });
});

describe('analytics', () => {
  it('fills gaps inside observed history but not before it starts', () => {
    const s = bucketActivity([{ hour: '2026-11-05T10:00:00Z', prompts: 2 }, { hour: '2026-11-05T13:00:00Z', prompts: 1 }], 'UTC');
    expect(s.unit).toBe('hour');
    expect(s.points.map((p) => p.value)).toEqual([2, 0, 0, 1]);
    expect(bucketActivity([], 'UTC').points).toEqual([]);
  });
  it('switches to local days for long spans without losing prompts', () => {
    const s = bucketActivity([{ hour: '2026-10-01T22:00:00Z', prompts: 3 }, { hour: '2026-10-20T05:00:00Z', prompts: 4 }], 'Europe/Zurich');
    expect(s.unit).toBe('day');
    expect(s.points[0]).toMatchObject({ key: '2026-10-02', value: 3 });
    expect(s.points.reduce((a, p) => a + p.value, 0)).toBe(7);
  });
  it('builds a Monday-first heatmap in the display timezone', () => {
    const h = buildHeatmap([{ hour: '2026-11-01T23:00:00Z', prompts: 5 }, { hour: '2026-11-02T09:00:00Z', prompts: 2 }], 'Europe/Zurich');
    expect(h.grid[0][0]).toBe(5); // Sunday 23:00 UTC is Monday 00:00 in Zurich
    expect(h.grid[0][10]).toBe(2);
    expect(h).toMatchObject({ total: 7, max: 5, activeDays: 1, peakHour: { hour: 0, count: 5 } });
    expect(buildHeatmap([], 'UTC')).toMatchObject({ total: 0, peakHour: null, busiestDay: null, spanDays: 0 });
  });
  it('never counts more active days than calendar days', () => {
    // An hour apart, but on two dates in Zurich.
    const late = buildHeatmap([{ hour: '2026-11-01T22:00:00Z', prompts: 1 }, { hour: '2026-11-01T23:00:00Z', prompts: 1 }], 'Europe/Zurich');
    expect(late).toMatchObject({ activeDays: 2, spanDays: 2 });
    // A rolling week that starts mid-afternoon touches eight dates.
    const rows = Array.from({ length: 8 }, (_, i) => ({ hour: new Date(Date.UTC(2026, 9, 25 + i, 15)).toISOString(), prompts: 1 }));
    const week = buildHeatmap(rows, 'UTC', { since: '2026-10-25T14:30:00Z', until: '2026-11-01T14:30:00Z' });
    expect(week.activeDays).toBeLessThanOrEqual(week.spanDays);
    expect(week.spanDays).toBe(8);
  });
  it('computes percentiles and returns null with no data', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([], 0.5)).toBeNull();
  });
  const tool = (o: Partial<ToolRow>): ToolRow => ({
    id: Math.random().toString(), source_id: 's', thread_id: 't', run_id: 'r', project_id: 'p', occurred_at: '2026-11-05T10:00:00Z', quality: 'partial',
    name: 'shell', category: 'shell', model: null, status: 'completed', exit: 0, duration: 100, chars: 10, redactions: 0, categories: [], preview: '', parent: null, ...o,
  });
  it('excludes unknown durations from tool percentiles rather than counting zero', () => {
    const [s] = toolStats([tool({ duration: 100 }), tool({ duration: null }), tool({ duration: 300, status: 'failed' })]);
    expect(s).toMatchObject({ calls: 3, failed: 1, timed: 2, p50: 200, max: 300 });
    expect(toolStats([tool({ duration: null })])[0].p50).toBeNull();
  });
  it('measures shell exit codes only against calls that report one', () => {
    const s = toolSummary([tool({ exit: 1 }), tool({ exit: 0 }), tool({ exit: null }), tool({ category: 'search', exit: null })]);
    expect(s).toMatchObject({ shell: 3, exitKnown: 2, nonZero: 1 });
  });
  it('stacks by local day and keeps empty days on the axis', () => {
    const rows = stackByDay(
      [{ t: '2026-11-01T12:00:00Z', k: 'a' }, { t: '2026-11-01T13:00:00Z', k: 'b' }, { t: '2026-11-04T13:00:00Z', k: 'a' }, { t: 'bad', k: 'a' }],
      (r) => r.t, (r) => r.k, 'UTC',
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(rows[0]).toMatchObject({ a: 1, b: 1 });
    expect(rows[1].a).toBeUndefined();
  });
  it('reports field coverage from what records actually hold', () => {
    const threads = [toThread(entity({ lineage_resolved: true, model: 'm' })), toThread(entity({ lineage_resolved: false }))] as ThreadRow[];
    const c = coverageRows(threads, [], [tool({ category: 'shell', exit: null }), tool({ category: 'unknown', exit: null })]);
    const by = Object.fromEntries(c.map((r) => [r.id, r]));
    expect(by['thread-lineage']).toMatchObject({ known: 1, total: 2 });
    expect(by['turn-usage']).toMatchObject({ known: 0, total: 0 });
    expect(by['tool-exit']).toMatchObject({ known: 0, total: 1 });
    expect(by['agent-return'].total).toBe(0);
  });
  it('counts a record once per redaction category', () => {
    expect(redactionTotals([{ categories: ['path', 'path', 'bearer'] }, { categories: ['path'] }])).toEqual([{ category: 'path', records: 2 }, { category: 'bearer', records: 1 }]);
  });
  it('sums only reported tokens and names models that reported none', () => {
    const base = { calls: null, observed_runs: 1 };
    const s = tokenSummary([
      { ...base, model: 'a', input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 80, reasoning_tokens: null, observed_provider_turns: 5, turns_with_usage: 5, complete_usage_turns: 4 },
      { ...base, model: 'grok', input_tokens: null, output_tokens: null, total_tokens: null, observed_provider_turns: 3, turns_with_usage: 0, complete_usage_turns: 0 },
      { ...base, model: 'never-ran', input_tokens: null, output_tokens: null, total_tokens: null, observed_provider_turns: 0, turns_with_usage: 0, complete_usage_turns: 0 },
    ]);
    expect(s).toMatchObject({ total: 110, input: 100, cached: 80, reasoning: null, turns: 8, withUsage: 5, complete: 4, noUsage: ['grok'] });
    expect(tokenSummary([{ ...base, model: 'old', input_tokens: null, output_tokens: null }])).toMatchObject({ total: null, turns: null, noUsage: [] });
  });
  it('totals tokens per key without treating a missing total as zero', () => {
    const m = tokensByKey([{ k: 'a', v: 5 }, { k: 'a', v: null }, { k: 'b', v: null }], (r) => r.k, (r) => r.v);
    expect(m.get('a')).toEqual({ total: 5, turns: 2, withUsage: 1, withTotal: 1 });
    expect(m.get('b')).toEqual({ total: null, turns: 1, withUsage: 0, withTotal: 0 });
  });
  it('measures provider usage from turns rather than assuming it', () => {
    const turn = (provider: string | null, usage: string, total: number | null) => toTurn(entity({ provider, usage_status: usage, total_tokens: total }));
    expect(usageByProvider([turn('codex', 'complete', 10), turn('codex', 'partial', 5), turn('grok', 'unavailable', null), turn(null, 'complete', 1)])).toEqual([
      { provider: 'codex', turns: 2, complete: 1, partial: 1, unavailable: 0, total: 15 },
      { provider: 'grok', turns: 1, complete: 0, partial: 0, unavailable: 1, total: null },
      { provider: 'Not recorded', turns: 1, complete: 1, partial: 0, unavailable: 0, total: 1 },
    ]);
  });
  it('counts partial and cache-only usage without inventing a total', () => {
    const partial=toTurn(entity({input_tokens:10,total_tokens:null,usage_status:'partial'}));
    const zero=toTurn(entity({cache_write_tokens:0,total_tokens:null,usage_status:'partial'}));
    const absent=toTurn(entity({usage_status:'unavailable'}));
    const coverage=coverageRows([],[],[],[partial,zero,absent]);
    expect(coverage.find((r)=>r.id==='turn-usage')).toMatchObject({known:2,total:3});
  });
  it('weights a day stack by tokens', () => {
    const rows = stackByDay([{ t: '2026-11-01T12:00:00Z', v: 100 }, { t: '2026-11-01T13:00:00Z', v: 5 }], (r) => r.t, () => 'm', 'UTC', (r) => r.v);
    expect(rows[0].m).toBe(105);
  });
  it('gives no delta without a previous value', () => {
    expect(delta(10, 0)).toBeNull();
    expect(delta(15, 10)).toBe(0.5);
  });
});

describe('filters', () => {
  it('sends each endpoint only what it can honour', () => {
    const f = { project: 'p', model: 'm', instance: 'i', since: '2026-01-01T00:00:00.000Z' };
    expect(Object.fromEntries(apiParams('tool-calls', f))).toEqual({ project: 'p', model: 'm', instance: 'i', since: f.since });
    expect(Object.fromEntries(apiParams('usage/projects', f))).toEqual({ instance: 'i', since: f.since });
    expect(Object.fromEntries(apiParams('projects', f))).toEqual({ instance: 'i' });
    expect(Object.fromEntries(apiParams('threads', f, { limit: 5 }))).toEqual({ project: 'p', instance: 'i', limit: '5' });
    expect(Object.fromEntries(apiParams('overview', f))).toEqual({ project: 'p', model: 'm', instance: 'i', since: f.since });
  });
  it('never forwards page-only URL keys, which the API rejects', () => {
    const p = resolveFilters(new URLSearchParams('page=Threads&tq=x&type=child&sort=title&project=p'));
    expect(Object.fromEntries(apiParams('overview', p))).toEqual({ project: 'p' });
  });
  it('anchors a range preset to the minute and overrides stale dates', () => {
    const now = Date.parse('2026-11-06T12:34:56Z');
    const f = resolveFilters(new URLSearchParams('range=24h&since=2020-01-01T00:00:00Z&until=2020-01-02T00:00:00Z'), now);
    expect(f.since).toBe('2026-11-05T12:34:00.000Z');
    expect(f.until).toBeUndefined();
    expect(previousWindow(f)).toEqual({ since: '2026-11-04T12:34:00.000Z', until: '2026-11-05T12:33:59.999Z' });
    expect(previousWindow({})).toBeNull();
    expect(previousWindow({ since: '2026-11-05T12:00:00.000Z', until: '2026-11-05T14:00:00.000Z' })).toEqual({ since: '2026-11-05T10:00:00.000Z', until: '2026-11-05T11:59:59.999Z' });
  });
  it('ignores an unknown range', () => {
    expect(resolveFilters(new URLSearchParams('range=9y')).range).toBeUndefined();
  });
  it('applies time bounds inclusively', () => {
    const f = { since: '2026-01-02T00:00:00Z', until: '2026-01-03T00:00:00Z' };
    expect(inTimeRange('2026-01-02T00:00:00Z', f)).toBe(true);
    expect(inTimeRange('2026-01-01T23:59:59Z', f)).toBe(false);
    expect(inTimeRange('2026-01-03T00:00:01Z', f)).toBe(false);
  });
});

describe('url', () => {
  it('keeps global filters and drops page state when moving pages', () => {
    const next = new URLSearchParams(pageSearch('?page=Threads&project=p&range=7d&tq=x&offset=50&id=1', 'Models'));
    expect(Object.fromEntries(next)).toEqual({ page: 'Models', project: 'p', range: '7d' });
  });
  it('removes keys patched to empty values', () => {
    expect(applyPatch('?a=1&b=2', { a: null, b: '', c: 3 }).toString()).toBe('c=3');
  });
  it('resolves the legacy quota page name and falls back on unknown pages', () => {
    expect(resolvePage(new URLSearchParams('page=Quota+and+Resets'))).toBe('Quota and Resets');
    expect(resolvePage(new URLSearchParams('page=Nope'))).toBe('Overview');
  });
});

describe('api', () => {
  const respond = (rows: unknown[]) => new Response(JSON.stringify({ data: rows }), { status: 200 });

  it('classifies failures so the UI can offer the right recovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    await expect(getJson('overview')).rejects.toMatchObject({ kind: 'offline' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
    await expect(getJson('overview')).rejects.toMatchObject({ kind: 'invalid' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(getJson('overview')).rejects.toBeInstanceOf(ApiError);
    vi.unstubAllGlobals();
  });
  it('stops scanning at the cap and says the result is incomplete', async () => {
    const f = vi.fn(async (url: string) => respond(Array.from({ length: Number(new URL(url, 'http://x').searchParams.get('limit')) }, (_, i) => i)));
    vi.stubGlobal('fetch', f);
    const r = await scanPages<number, number>('tool-calls', new URLSearchParams(), (x) => x, 700);
    expect(r).toMatchObject({ scanned: 700, complete: false });
    expect(f).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it('shrinks the page when a large one fails, without losing or repeating rows', async () => {
    const f = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      const limit = Number(u.searchParams.get('limit'));
      const offset = Number(u.searchParams.get('offset'));
      if (limit > 200) return new Response('{}', { status: 400 });
      const total = 300;
      return respond(Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => offset + i));
    });
    vi.stubGlobal('fetch', f);
    const r = await scanPages<number, number>('tool-calls', new URLSearchParams(), (x) => x, 10_000);
    expect(r).toMatchObject({ complete: true, scanned: 300 });
    expect(r.rows).toEqual(Array.from({ length: 300 }, (_, i) => i));
    vi.unstubAllGlobals();
  });
  it('keeps the rows it has when a later page keeps failing, and marks the scan partial', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls += 1;
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset'));
      if (offset > 0) return new Response('{}', { status: 400 });
      return respond(Array.from({ length: 500 }, (_, i) => i));
    }));
    const r = await scanPages<number, number>('tool-calls', new URLSearchParams(), (x) => x, 10_000);
    expect(r).toMatchObject({ complete: false, failed: true, scanned: 500 });
    expect(calls).toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });
  it('asks for several pages at once after a full one, and keeps every record once', async () => {
    const total = 2_300;
    let inFlight = 0;
    let most = 0;
    const f = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      const limit = Number(u.searchParams.get('limit'));
      const offset = Number(u.searchParams.get('offset'));
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      // A new record arrives while the scan runs, pushing everything down one place.
      const shift = offset > 0 ? 1 : 0;
      return respond(Array.from({ length: Math.max(0, Math.min(limit, total + shift - offset)) }, (_, i) => ({ id: `r${offset + i - shift}` })));
    });
    vi.stubGlobal('fetch', f);
    const r = await scanPages<{ id: string }, string>('model-turns', new URLSearchParams(), (x) => x.id, 50_000);
    expect(r.complete).toBe(true);
    expect(new Set(r.rows).size).toBe(r.rows.length);
    expect(r.rows.length).toBeGreaterThanOrEqual(total);
    expect(most).toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });
  it('steps down from a big page that an older service refuses, without losing rows', async () => {
    const f = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      const limit = Number(u.searchParams.get('limit'));
      const offset = Number(u.searchParams.get('offset'));
      if (limit > 500) return new Response('{}', { status: 400 });
      return respond(Array.from({ length: Math.max(0, Math.min(limit, 1_300 - offset)) }, (_, i) => ({ id: `r${offset + i}` })));
    });
    vi.stubGlobal('fetch', f);
    const r = await scanPages<{ id: string }, string>('model-turns', new URLSearchParams(), (x) => x.id, 50_000, undefined, 5_000);
    expect(r).toMatchObject({ complete: true, scanned: 1_300 });
    expect(new Set(r.rows).size).toBe(1_300);
    vi.unstubAllGlobals();
  });
  it('falls back to one page at a time when a page asked ahead fails', async () => {
    const f = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      const limit = Number(u.searchParams.get('limit'));
      const offset = Number(u.searchParams.get('offset'));
      if (offset === 1_000 && limit === 500) return new Response('{}', { status: 400 });
      return respond(Array.from({ length: Math.max(0, Math.min(limit, 1_800 - offset)) }, (_, i) => ({ id: `r${offset + i}` })));
    });
    vi.stubGlobal('fetch', f);
    const r = await scanPages<{ id: string }, string>('model-turns', new URLSearchParams(), (x) => x.id, 50_000);
    expect(r).toMatchObject({ complete: true, scanned: 1_800 });
    expect(r.rows).toEqual(Array.from({ length: 1_800 }, (_, i) => `r${i}`));
    vi.unstubAllGlobals();
  });
  it('still reports a failure when no page could be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    await expect(scanPages<number, number>('tool-calls', new URLSearchParams(), (x) => x, 10_000)).rejects.toMatchObject({ kind: 'invalid' });
    vi.unstubAllGlobals();
  });
  it('retries without include_content for a service that rejects the option', async () => {
    const f = vi.fn(async (url: string) => (String(url).includes('include_content') ? new Response('{}', { status: 400 }) : respond([{ id: 1 }])));
    vi.stubGlobal('fetch', f);
    expect(await getEntities('tool-calls', new URLSearchParams({ id: 'x', include_content: 'true' }))).toEqual([{ id: 1 }]);
    expect(f).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it('reports a complete scan when a short page arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond([1, 2])));
    expect(await scanPages<number, number>('threads', new URLSearchParams(), (x) => x, 700)).toMatchObject({ scanned: 2, complete: true });
    vi.unstubAllGlobals();
  });
  it('walks the capped hourly endpoint forward so the newest hours are not lost', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ hour: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), prompts: 1 }));
    const f = vi.fn().mockResolvedValueOnce(respond(first)).mockResolvedValueOnce(respond([{ hour: '2026-02-01T00:00:00.000Z', prompts: 1 }]));
    vi.stubGlobal('fetch', f);
    const rows = await scanHourly<{ hour: string }>(new URLSearchParams());
    expect(rows).toHaveLength(501);
    expect(String(f.mock.calls[1][0])).toContain('since=');
    vi.unstubAllGlobals();
  });
  it('quotes CSV cells and neutralises spreadsheet formulas in captured text', () => {
    expect(toCsv(['a', 'b'], [['=cmd()', 'x,"y"'], [1, null]])).toBe('a,b\r\n\'=cmd(),"x,""y"""\r\n1,');
  });
});

describe('providerFromThread', () => {
  it('reads the agent out of a provider thread id', () => {
    expect(providerFromThread('provider-thread:provider:codex:native-thread:01a')).toBe('codex');
    expect(providerFromThread('provider-thread:provider:claudeAgent:native-thread:x')).toBe('claudeAgent');
  });
  it('says nothing about an id it cannot read', () => {
    expect(providerFromThread('something-else')).toBeNull();
    expect(providerFromThread(null)).toBeNull();
  });
});

describe('capture gaps', () => {
  it('finds only long silences', () => {
    const at = (d: string) => `2026-${d}T10:00:00Z`;
    expect(captureGaps([at('06-13'), at('06-14'), at('08-16'), at('08-20'), at('08-29')])).toEqual([[Date.parse(at('06-14')) + 3_600_000, Date.parse(at('08-16'))]]);
    expect(captureGaps([])).toEqual([]);
  });
});

describe('short ranges', () => {
  const now = Date.parse('2026-11-06T12:17:00Z');
  it('anchors the last hour to the minute, so it really is an hour', () => {
    expect(resolveFilters(new URLSearchParams('range=1h'), now).since).toBe('2026-11-06T11:17:00.000Z');
    expect(resolveFilters(new URLSearchParams('range=6h'), now).since).toBe('2026-11-06T06:17:00.000Z');
  });
  it('makes the last 24 hours exactly 24 hours', () => {
    expect(resolveFilters(new URLSearchParams('range=24h'), now).since).toBe('2026-11-05T12:17:00.000Z');
  });
  it('treats a window ending in the future as reaching now, until that end has passed', () => {
    const q = new URLSearchParams('since=2026-11-06T00:00:00.000Z&until=2026-11-06T23:59:59.999Z');
    const open = resolveFilters(q, now);
    expect(open.until).toBeUndefined();
    expect(previousWindow(open, now)).toEqual({ since: '2026-11-05T11:43:00.000Z', until: '2026-11-05T23:59:59.999Z' });
    expect(resolveFilters(q, Date.parse('2026-11-07T00:00:00Z')).until).toBe('2026-11-06T23:59:59.999Z');
  });
  it('ignores a date it cannot read and turns a reversed pair the right way round', () => {
    expect(resolveFilters(new URLSearchParams('since=garbage&until=nope'), now)).toMatchObject({ since: undefined, until: undefined });
    const f = resolveFilters(new URLSearchParams('since=2026-11-01T00:00:00.000Z&until=2026-10-10T00:00:00.000Z'), now);
    expect(f.since).toBe('2026-10-10T00:00:00.000Z');
    expect(f.until).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('page totals', () => {
  it('splits window tokens by thread and keeps session-log hours apart, matching the whole', async () => {
    const { windowTokens } = await import('./analytics');
    const t = (id: string, thread: string, at: string, total: number | null, log = false) =>
      toTurn(entity({ total_tokens: total, usage_status: total === null ? 'unavailable' : 'complete', ...(log ? { usage_source: 'session_log' } : {}) }, { id, thread_id: thread, occurred_at: at, kind: 'model_turn' }));
    const w = windowTokens([
      t('a', 't1', '2026-11-05T10:00:00Z', 10),
      t('b', 't1', '2026-11-05T11:00:00Z', null),
      t('c', 't2', '2026-10-01T10:00:00Z', 99),
      t('d', '', '2026-11-05T12:00:00Z', 5, true),
      t('e', '', '2026-11-05T12:00:00Z', 2),
    ], { since: '2026-11-01T00:00:00Z', until: '2026-11-08T00:00:00Z' });
    expect(w.byThread.get('t1')).toEqual({ total: 10, turns: 2, withUsage: 1, withTotal: 1 });
    expect(w.byThread.has('t2')).toBe(false);
    expect(w.logTotal).toBe(5);
    expect(w.unthreaded).toBe(2);
    expect(w.total).toBe(17);
    expect([w.turns, w.reported]).toEqual([3, 2]);
  });
  it('takes the tool headline from service totals when only some calls were read', async () => {
    const { toolHeadline } = await import('./analytics');
    const loaded = { calls: 1000, failed: 10, statusKnown: 1000, shell: 400, exitKnown: 400, nonZero: 4, p50: 10, p95: 50, timed: 1000 };
    const full = { ...loaded, calls: 250_000, failed: 2000, statusKnown: 249_000 };
    expect(toolHeadline(loaded, true, { full })).toMatchObject({ calls: 250_000, sampled: { calls: false } });
    expect(toolHeadline(loaded, true, {})).toMatchObject({ calls: 1000, sampled: { calls: false } });
    expect(toolHeadline(loaded, false, { full })).toMatchObject({ calls: 250_000, failed: 2000, sampled: { calls: false, time: false, exit: false } });
    const stats = [
      { name: 'Read', category: 'unknown', calls: 500, failed: 5, statusKnown: 500, p50: 3, p95: 9, max: 20, timed: 500, chars: 0 },
      { name: 'Bash', category: 'shell', calls: 300, failed: 30, statusKnown: 300, p50: 7, p95: 99, max: 200, timed: 300, chars: 0 },
      { name: 'Grep', category: 'unknown', calls: 100, failed: 0, statusKnown: 100, p50: 1, p95: 2, max: 3, timed: 100, chars: 0 },
    ];
    expect(toolHeadline(loaded, false, { stats, tool: 'Bash' })).toMatchObject({ calls: 300, failed: 30, p50: 7, sampled: { calls: false, time: false, exit: true } });
    expect(toolHeadline(loaded, false, { stats, category: 'unknown' })).toMatchObject({ calls: 600, failed: 5, sampled: { calls: false, time: true } });
    expect(toolHeadline(loaded, false, { stats, status: 'failed' })).toMatchObject({ calls: 1000, sampled: { calls: true } });
  });
});
