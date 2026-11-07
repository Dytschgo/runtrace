import { describe, expect, it } from 'vitest';
import type { AgentRow, ThreadRow } from './entities';
import { buildForest, compressAxis, flatten, forestInView, mergeIntervals, peakConcurrency, treeStats } from './tree';

const thread = (id: string, o: Partial<ThreadRow> = {}): ThreadRow => ({
  id, source_id: id, instance_id: 'local', project_id: 'p', occurred_at: '2026-11-05T10:00:00Z', updated_at: null, quality: 'partial', version: null,
  title: id, type: 'primary', parent: null, root: null, depth: 0, resolved: true, relationship: null, branch: null, model: null, archived: null, worktree: null, tokens: null, toolCoverage: null, ...o,
});
const agent = (id: string, parent: string, child: string | null, o: Partial<AgentRow> = {}): AgentRow => ({
  id, source_id: id, thread_id: parent, run_id: 'r', project_id: 'p', instance_id: 'local', occurred_at: '2026-11-05T10:00:00Z', quality: 'partial', agentType: child ? 't3_child' : 'provider_native_subagent',
  child, parentRun: null, model: null, status: 'completed', started: '2026-11-05T10:00:00Z', completed: '2026-11-05T10:01:00Z', duration: 60_000, returned: null, task: null, result: null, redactions: null, categories: [], ...o,
});

describe('buildForest uses verified relationships only', () => {
  it('links a child through its agent record', () => {
    const f = buildForest([thread('root'), thread('kid')], [agent('a1', 'root', 'kid')]);
    expect(f.edges).toBe(1);
    expect(f.roots).toHaveLength(1);
    expect(f.roots[0].children[0]).toMatchObject({ key: 'kid', depth: 1, evidence: 'agent_record' });
  });
  it('links through explicit subagent lineage and notes when both sources agree', () => {
    const lineage = buildForest([thread('root'), thread('kid', { relationship: 'subagent', parent: 'root' })], []);
    expect(lineage.roots[0].children[0].evidence).toBe('thread_lineage');
    const both = buildForest([thread('root'), thread('kid', { relationship: 'subagent', parent: 'root' })], [agent('a1', 'root', 'kid')]);
    expect(both.roots[0].children[0].evidence).toBe('both');
    expect(both.edges).toBe(1);
  });
  it('does not treat a fork as delegation', () => {
    const f = buildForest([thread('root'), thread('fork', { relationship: 'fork', parent: 'root' })], []);
    expect(f.edges).toBe(0);
    expect(f.roots.map((r) => r.key).sort()).toEqual(['fork', 'root']);
  });
  it('never infers an edge from root_thread_id, titles or timing', () => {
    const f = buildForest([thread('root', { title: 'Same' }), thread('other', { title: 'Same', root: 'root', depth: 1 })], []);
    expect(f.edges).toBe(0);
    expect(f.standalone).toBe(2);
  });
  it('shows a missing parent as a reported root, with no invented node', () => {
    const f = buildForest([thread('kid', { relationship: 'subagent', parent: 'gone' })], []);
    expect(f.roots).toHaveLength(1);
    expect(f.roots[0]).toMatchObject({ key: 'kid', missingParent: 'gone', depth: 0 });
    expect(f.missingParents).toBe(1);
    expect(f.edges).toBe(0);
  });
  it('keeps a provider-native agent with no thread as a leaf of the thread that recorded it', () => {
    const f = buildForest([thread('root')], [agent('native', 'root', null, { task: 'Inspect logs\nmore' })]);
    const leaf = f.roots[0].children[0];
    expect(leaf).toMatchObject({ key: 'agent:native', thread: null, title: 'Inspect logs' });
  });
  it('refuses a link that would close a cycle and reports it', () => {
    const f = buildForest([thread('a'), thread('b')], [agent('1', 'b', 'a'), agent('2', 'a', 'b')]);
    expect(f.cycles).toBe(1);
    expect(f.edges).toBe(1);
    expect(f.roots).toHaveLength(1);
    expect(flatten(f.roots[0])).toHaveLength(2);
  });
  it('counts a conflict between sources and keeps the agent record', () => {
    const f = buildForest([thread('r1'), thread('r2'), thread('kid', { relationship: 'subagent', parent: 'r2' })], [agent('a', 'r1', 'kid')]);
    expect(f.conflicts).toBe(1);
    expect(f.roots.find((r) => r.key === 'r1')!.children[0].key).toBe('kid');
  });
  it('tracks depth across several levels', () => {
    const f = buildForest([thread('r'), thread('c'), thread('g')], [agent('1', 'r', 'c'), agent('2', 'c', 'g')]);
    const s = treeStats(f.roots[0]);
    expect(s).toMatchObject({ nodes: 3, delegated: 2, maxDepth: 2, maxFanout: 1 });
  });
});

describe('tree statistics', () => {
  it('keeps unknown delivery and missing end times separate from known values', () => {
    const f = buildForest([thread('r'), thread('a'), thread('b'), thread('c')], [
      agent('1', 'r', 'a', { returned: true }),
      agent('2', 'r', 'b', { returned: false }),
      agent('3', 'r', 'c', { returned: null, completed: null, duration: null }),
    ]);
    expect(treeStats(f.roots[0])).toMatchObject({ returned: 1, notReturned: 1, returnUnknown: 1, openEnded: 1, timed: 2, delegated: 3 });
  });
  it('flatten hides children of collapsed nodes', () => {
    const f = buildForest([thread('r'), thread('c'), thread('g')], [agent('1', 'r', 'c'), agent('2', 'c', 'g')]);
    expect(flatten(f.roots[0]).map((n) => n.key)).toEqual(['r', 'c', 'g']);
    expect(flatten(f.roots[0], new Set(['c'])).map((n) => n.key)).toEqual(['r', 'c']);
  });
});

describe('time helpers', () => {
  it('merges overlapping intervals without mutating input', () => {
    const input: [number, number][] = [[10, 20], [0, 5], [15, 30]];
    expect(mergeIntervals(input)).toEqual([[0, 5], [10, 30]]);
    expect(input[0]).toEqual([10, 20]);
  });
  it('finds peak concurrency and does not count touching runs as parallel', () => {
    expect(peakConcurrency([[0, 10], [5, 15], [6, 7]])).toBe(3);
    expect(peakConcurrency([[0, 5], [5, 10]])).toBe(1);
    expect(peakConcurrency([])).toBe(0);
  });
  it('shortens long idle gaps so brief runs stay visible, in order', () => {
    const day = 86_400_000;
    const axis = compressAxis([[0, 60_000], [10 * day, 10 * day + 60_000]]);
    expect(axis.gaps).toHaveLength(1);
    expect(axis.at(0)).toBe(0);
    expect(axis.at(10 * day + 60_000)).toBe(100);
    // The first minute would be invisible on a true 10-day scale; compressed it is close to half.
    expect(axis.at(60_000)).toBeGreaterThan(45);
    expect(axis.at(10 * day)).toBeGreaterThan(axis.at(60_000));
  });
  it('handles no intervals', () => {
    const axis = compressAxis([]);
    expect(axis.at(5)).toBe(0);
    expect(axis.gaps).toEqual([]);
  });
});

describe('forestInView', () => {
  const f = buildForest(
    [thread('r'), thread('c'), thread('lone'), thread('old', { occurred_at: '2026-01-01T00:00:00Z' })],
    [agent('1', 'r', 'c')],
  );
  it('counts only threads that ran inside the window', () => {
    const v = forestInView(f.roots, { since: '2026-11-01T00:00:00Z', until: '2026-11-08T00:00:00Z' });
    expect(v.trees.map((t) => t.key)).toEqual(['r']);
    expect(v.standalone).toBe(1);
    expect(v.threads).toBe(2);
  });
  it('says nothing about threads outside an empty window', () => {
    const v = forestInView(f.roots, { since: '2025-01-01T00:00:00Z', until: '2025-01-02T00:00:00Z' });
    expect(v).toEqual({ trees: [], standalone: 0, threads: 0 });
  });
});

describe('tree numbers inside a window', () => {
  it('count only sub-agents started in the window and cut busy time to it', async () => {
    const { treeStats } = await import('./tree');
    const node = (key: string, depth: number, start: number | null, end: number | null, children: any[] = []): any => ({ key, title: key, thread: null, agent: null, children, depth, evidence: null, missingParent: null, cycle: false, start, end });
    const H = 3_600_000;
    const root = node('r', 0, 0, 10 * H, [node('a', 1, 0, H), node('b', 1, 5 * H, 7 * H, [node('c', 2, 6 * H, 6.5 * H)]), node('d', 1, 9 * H, null)]);
    const all = treeStats(root);
    expect(all.delegated).toBe(4);
    const s = treeStats(root, { since: new Date(5.5 * H).toISOString(), until: new Date(8 * H).toISOString() });
    expect(s).toMatchObject({ delegated: 1, wholeTree: 4, maxDepth: 2, busyMs: 1.5 * H });
  });
});
