import { describe, expect, it } from 'vitest';
import type { AgentRow, ThreadRow } from './entities';
import { activeLanes, buildStory, delegateReport, fallbackRoot, findNode, indexAt, latestBefore, packRows, storyAxis } from './story';
import { buildForest } from './tree';
import type { Entity } from './types';

const T0 = Date.parse('2026-11-05T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const thread = (id: string, o: Partial<ThreadRow> = {}): ThreadRow => ({
  id, source_id: id, instance_id: 'local', project_id: 'p', occurred_at: at(0), updated_at: null, quality: 'partial', version: null,
  title: id, type: 'primary', parent: null, root: null, depth: 0, resolved: true, relationship: null, branch: null, model: 'gpt-x', archived: null, worktree: null, tokens: null, toolCoverage: null, ...o,
});
const agent = (id: string, parent: string, child: string | null, start: number, end: number | null, o: Partial<AgentRow> = {}): AgentRow => ({
  id, source_id: id, thread_id: parent, run_id: 'r', project_id: 'p', instance_id: 'local', occurred_at: at(start), quality: 'partial', agentType: 't3_child',
  child, parentRun: null, model: 'claude-y', status: 'completed', started: at(start), completed: end === null ? null : at(end), duration: end === null ? null : (end - start) * 1000,
  returned: true, task: 'Do the thing\nmore detail', result: 'Done.', redactions: null, categories: [], ...o,
});
const ev = (kind: string, s: number, data: Record<string, unknown> = {}, id = `${kind}-${s}`): Entity => ({
  id, source_id: id, kind, instance_id: 'local', project_id: 'p', thread_id: 'root', run_id: 'run-1', occurred_at: at(s), data,
});

describe('delegateReport', () => {
  it('names a delegated task reporting back, without its internal id', () => {
    expect(delegateReport('Delegated task node:delegated-task:command%3Amcp%3Aabc (Council round 4: Sol) [completed]:\n7/10')).toBe('“Council round 4: Sol” reported back');
    expect(delegateReport('Delegated task node:x (Build) [needs_input]: help')).toBe('“Build” reported back: needs input');
    expect(delegateReport('Delegated task node:delegated-task:command%3Amcp%3Aabc…')).toBe('A delegated task reported back');
  });
  it('leaves what you wrote alone', () => {
    expect(delegateReport('Please fix the Delegated task page')).toBeNull();
    expect(delegateReport(null)).toBeNull();
  });
});

describe('storyAxis', () => {
  it('shortens idle gaps, keeps order, and inverts', () => {
    const day = 86_400_000;
    const axis = storyAxis([[0, 60_000], [10 * day, 10 * day + 60_000]]);
    expect(axis.gaps).toHaveLength(1);
    expect(axis.gaps[0].to - axis.gaps[0].from).toBe(10 * day - 60_000);
    expect(axis.toX(0)).toBe(0);
    expect(axis.toX(10 * day + 60_000)).toBe(1);
    expect(axis.toX(60_000)).toBeGreaterThan(0.45);
    for (const t of [0, 30_000, 60_000, 10 * day, 10 * day + 30_000]) expect(Math.abs(axis.toT(axis.toX(t)) - t)).toBeLessThan(2);
    expect(axis.spanMs).toBe(10 * day + 60_000);
    expect(axis.compressedMs).toBeLessThan(axis.spanMs);
  });
  it('gives single instants a visible width instead of dividing by zero', () => {
    const axis = storyAxis([[5000, 5000]]);
    expect(axis.toX(5000)).toBe(0);
    expect(axis.toX(6000)).toBe(1);
    expect(Number.isFinite(axis.toT(0.5))).toBe(true);
  });
  it('handles nothing', () => {
    const axis = storyAxis([]);
    expect(axis.toX(1)).toBe(0);
    expect(axis.gaps).toEqual([]);
  });
});

describe('packRows', () => {
  it('shares a row between runs that do not overlap and splits ones that do', () => {
    const { rows, count } = packRows([{ x0: 0, x1: 0.2 }, { x0: 0.1, x1: 0.3 }, { x0: 0.25, x1: 0.5 }, { x0: 0.6, x1: 0.7 }]);
    expect(count).toBe(2);
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBe(1);
    expect(rows[2]).toBe(0);
    expect(rows[3]).toBe(0);
  });
});

describe('buildStory', () => {
  const forest = () => buildForest(
    [thread('root'), thread('kid', { type: 'child', relationship: 'subagent', parent: 'root', model: 'claude-y' }), thread('grandkid', { type: 'child', relationship: 'subagent', parent: 'kid' })],
    [agent('a1', 'root', 'kid', 10, 70), agent('a2', 'kid', 'grandkid', 20, 40, { status: 'failed', result: 'Claude API rate limit reached.', returned: null }), agent('a3', 'root', null, 80, null, { agentType: 'provider_native_subagent', task: 'Inspect logs' })],
  );
  const events = () => [
    ev('answer', 90, { content_redacted: 'All done.', model: 'gpt-x' }),
    ev('tool', 50, { tool_name: 'command_execution', status: 'failed', exit_code: 1, content_redacted: '{"arguments":"npm test","result":null}' }),
    ev('tool', 30, { tool_name: 'read', status: 'completed' }),
    ev('tool', 31, { tool_name: 'read' }),
    ev('model_turn', 5, { model: 'gpt-x', total_tokens: 1200, usage_status: 'complete' }),
    ev('model_turn', 60, { model: 'gpt-x', total_tokens: null, usage_status: 'partial' }),
    ev('run', 5, { started_at: at(5), completed_at: at(95), requested_model: 'gpt-x', status: 'completed' }),
    ev('agent', 10, { child_thread_id: 'kid', model: 'claude-y', status: 'completed', started_at: at(10), completed_at: at(70) }, 'a1'),
    ev('prompt', 0, { content_redacted: 'Please fix the tests', content_truncated: true }),
    ev('prompt', 2, { content_redacted: null }),
    ev('thread', 0, { title: 'root' }),
  ];

  it('lays every recorded thing on one clock and never invents a lane', () => {
    const root = findNode(forest().roots, 'root')!;
    const story = buildStory(root, events());
    expect(story.lanes.map((l) => l.key)).toEqual(['root', 'kid', 'grandkid', 'agent:a3']);
    expect(story.lanes[0].row).toBe(0);
    expect(story.lanes.find((l) => l.key === 'grandkid')!.parent).toBe('kid');
    // The grandchild overlaps its parent, so it needs its own row; the native agent starts after both end and reuses a row.
    expect(story.rows).toBe(3);
    expect(story.lanes.find((l) => l.key === 'agent:a3')).toMatchObject({ open: true, thread: null, row: 1 });
    expect(story.runs).toHaveLength(1);
    expect(story.runs[0]).toMatchObject({ model: 'gpt-x', open: false });
    expect(story.events.map((e) => e.t)).toEqual([...story.events.map((e) => e.t)].sort((a, b) => a - b));
  });

  it('narrates prompts, delegations, failures and answers but not routine tool calls', () => {
    const story = buildStory(findNode(forest().roots, 'root')!, events());
    const lines = story.narrated.map((e) => e.line);
    expect(lines[0]).toBe('You asked “Please fix the tests”');
    expect(lines).toContain('You asked, but the text was withheld by capture policy');
    expect(lines).toContain('Delegated to claude-y: kid');
    expect(lines).toContain('Delegated to claude-y: grandkid');
    expect(lines.find((l) => l?.startsWith('command_execution failed with exit code 1'))).toBeTruthy();
    expect(lines).toContain('claude-y failed after 20 s “Claude API rate limit reached.”');
    expect(lines).toContain('gpt-x answered “All done.”');
    expect(lines.some((l) => l?.includes('read'))).toBe(false);
    // The timeline's own agent event is not a second delegation when the tree already has the lane.
    expect(story.narrated.filter((e) => e.kind === 'spawn')).toHaveLength(3);
  });

  it('keeps running totals that count only what was reported', () => {
    const story = buildStory(findNode(forest().roots, 'root')!, events());
    const last = story.events.length - 1;
    expect(story.counts.prompts[last]).toBe(2);
    expect(story.counts.tools[last]).toBe(3);
    expect(story.counts.toolsFailed[last]).toBe(1);
    expect(story.counts.spawned[last]).toBe(3);
    expect(story.counts.finished[last]).toBe(2);
    expect(story.counts.agentsFailed[last]).toBe(1);
    expect(story.counts.tokens[last]).toBe(1200);
    expect(story.counts.turnsWithTotal[last]).toBe(1);
    expect(story.gaps).toMatchObject({ agentsNoEnd: 1, agentsDeliveryUnknown: 1, turns: 2, turnsWithoutTotal: 1, toolsNoStatus: 1, textCut: 1, withheld: 1 });
  });

  it('answers what is happening at any instant', () => {
    const story = buildStory(findNode(forest().roots, 'root')!, events());
    const i = indexAt(story.events, T0 + 45_000);
    expect(story.counts.spawned[i - 1]).toBe(2);
    expect(story.counts.finished[i - 1]).toBe(1);
    expect(latestBefore(story.events, i, 'prompt')!.t).toBe(T0 + 2000);
    expect(activeLanes(story.lanes, T0 + 45_000, story.axis).map((l) => l.key)).toEqual(['kid']);
    expect(activeLanes(story.lanes, T0 + 25_000, story.axis).map((l) => l.key).sort()).toEqual(['grandkid', 'kid']);
    expect(indexAt(story.events, T0 - 1)).toBe(0);
    expect(indexAt(story.events, T0 + 10_000_000)).toBe(story.events.length);
  });

  it('keeps every task sent to the same delegated thread on one lane', () => {
    const more = [...events(), ev('agent', 75, { child_thread_id: 'kid', model: 'claude-y', status: 'failed', started_at: at(75), completed_at: at(85), content_redacted: '{"result":"Rate limited","task":"Try again with fewer files"}' }, 'a1-again')];
    const story = buildStory(findNode(forest().roots, 'root')!, more);
    const kid = story.lanes.find((l) => l.key === 'kid')!;
    expect(kid.sends).toHaveLength(2);
    expect(kid.sends.map((s) => s.agent?.source_id)).toEqual(['a1', 'a1-again']);
    expect(kid).toMatchObject({ status: 'failed', duration: 70_000, open: false });
    expect(kid.end).toBe(T0 + 85_000);
    expect(story.sends).toBe(4);
    expect(story.lanes).toHaveLength(4);
    expect(story.narrated.map((e) => e.line)).toContain('Sent a follow-up task to claude-y “Try again with fewer files”');
    expect(story.narrated.map((e) => e.line)).toContain('claude-y failed after 10 s “Rate limited”');
    const last = story.events.length - 1;
    expect(story.counts.spawned[last]).toBe(4);
    expect(story.counts.agentsFailed[last]).toBe(2);
  });

  it('builds from the timeline alone when the thread is not in the forest', () => {
    const root = fallbackRoot('root', null, events().filter((e) => e.kind === 'agent'));
    expect(root.children).toHaveLength(1);
    const story = buildStory(root, events());
    expect(story.lanes).toHaveLength(2);
    expect(story.lanes[1]).toMatchObject({ key: 'kid', model: 'claude-y', open: false });
    expect(story.narrated.filter((e) => e.kind === 'spawn')).toHaveLength(1);
  });
});
