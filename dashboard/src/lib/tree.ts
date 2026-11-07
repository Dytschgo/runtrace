import type { AgentRow, ThreadRow } from './entities';

export type EdgeEvidence = 'agent_record' | 'thread_lineage' | 'both';

export interface TreeNode {
  key: string;
  title: string;
  thread: ThreadRow | null;
  agent: AgentRow | null;
  children: TreeNode[];
  depth: number;
  evidence: EdgeEvidence | null;
  /** A recorded parent id that is not among the imported threads. No placeholder is drawn for it. */
  missingParent: string | null;
  cycle: boolean;
  start: number | null;
  end: number | null;
}

export interface Forest {
  roots: TreeNode[];
  edges: number;
  standalone: number;
  missingParents: number;
  cycles: number;
  conflicts: number;
}

const ms = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Builds delegation trees from explicit records only: an agent's child_thread_id or a thread whose
 * relationship_to_parent is "subagent". Forks, shared titles, timing and root_thread_id never create an edge.
 */
export function buildForest(threads: ThreadRow[], agents: AgentRow[]): Forest {
  const nodes = new Map<string, TreeNode>();
  const agentByChild = new Map<string, AgentRow>();
  for (const a of agents) if (a.child) agentByChild.set(a.child, a);

  for (const t of threads) {
    const a = agentByChild.get(t.source_id) ?? null;
    nodes.set(t.source_id, {
      key: t.source_id, title: t.title, thread: t, agent: a, children: [], depth: 0, evidence: null, missingParent: null, cycle: false,
      start: ms(a?.started) ?? ms(t.occurred_at), end: ms(a?.completed),
    });
  }

  const parentOf = new Map<string, { parent: string; evidence: EdgeEvidence }>();
  let conflicts = 0;
  for (const a of agents) {
    // An agent without an imported thread of its own stays an explicit leaf of the thread that recorded it.
    const key = a.child ?? `agent:${a.source_id}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        key, title: a.task?.split('\n')[0].slice(0, 120) || (a.agentType === 'provider_native_subagent' ? 'Provider-native sub-agent' : 'Sub-agent'),
        thread: null, agent: a, children: [], depth: 0, evidence: null, missingParent: null, cycle: false,
        start: ms(a.started) ?? ms(a.occurred_at), end: ms(a.completed),
      });
    }
    if (a.thread_id) parentOf.set(key, { parent: a.thread_id, evidence: 'agent_record' });
  }
  for (const t of threads) {
    if (t.relationship !== 'subagent' || !t.parent) continue;
    const known = parentOf.get(t.source_id);
    if (!known) parentOf.set(t.source_id, { parent: t.parent, evidence: 'thread_lineage' });
    else if (known.parent === t.parent) known.evidence = 'both';
    else conflicts++;
  }

  let edges = 0;
  let missingParents = 0;
  let cycles = 0;
  const linked = new Set<string>();
  for (const [key, link] of parentOf) {
    const node = nodes.get(key)!;
    if (!nodes.has(link.parent)) {
      node.missingParent = link.parent;
      missingParents++;
      continue;
    }
    // A link that would close a loop is not drawn; the node becomes a root and is reported.
    let cursor: string | undefined = link.parent;
    const seen = new Set<string>([key]);
    let loop = false;
    while (cursor) {
      if (seen.has(cursor)) { loop = true; break; }
      seen.add(cursor);
      cursor = linked.has(cursor) ? parentOf.get(cursor)?.parent : undefined;
    }
    if (loop) { node.cycle = true; cycles++; continue; }
    node.evidence = link.evidence;
    nodes.get(link.parent)!.children.push(node);
    linked.add(key);
    edges++;
  }

  const place = (n: TreeNode, depth: number) => {
    n.depth = depth;
    n.children.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    for (const c of n.children) place(c, depth + 1);
  };
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    if (!linked.has(n.key)) { roots.push(n); place(n, 0); }
  }
  roots.sort((a, b) => latest(b) - latest(a));
  return { roots, edges, standalone: roots.filter((r) => !r.children.length).length, missingParents, cycles, conflicts };
}

function latest(n: TreeNode): number {
  return Math.max(n.end ?? 0, n.start ?? 0, ...n.children.map(latest));
}

export function flatten(root: TreeNode, collapsed?: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    out.push(n);
    if (!collapsed?.has(n.key)) n.children.forEach(walk);
  };
  walk(root);
  return out;
}

export interface TreeStats {
  nodes: number; delegated: number; maxDepth: number; maxFanout: number; peakParallel: number;
  busyMs: number; spanMs: number; returned: number; notReturned: number; returnUnknown: number; openEnded: number; timed: number;
  /** Every sub-agent in the tree, whatever the window. */
  wholeTree: number;
}

export interface StatsWindow { since?: string; until?: string }

/**
 * A tree's numbers. With a window, only sub-agents started inside it count, and busy time is cut to it, so a tree that ran for weeks
 * does not credit an hour with everything it ever did. The tree itself is still shown whole.
 */
export function treeStats(root: TreeNode, win?: StatsWindow): TreeStats {
  const all = flatten(root);
  const from = win?.since ? Date.parse(win.since) : -Infinity;
  const to = win?.until ? Date.parse(win.until) : Infinity;
  const windowed = from > -Infinity || to < Infinity;
  const everyDelegated = all.filter((n) => n.depth > 0);
  // A sub-agent belongs to the window its record falls in, the same rule every other count uses, so this page and the Overview agree.
  const recordedAt = (n: TreeNode) => { const t = n.agent ? Date.parse(n.agent.occurred_at) : n.thread ? Date.parse(n.thread.occurred_at) : NaN; return Number.isFinite(t) ? t : n.start; };
  const delegated = windowed ? everyDelegated.filter((n) => { const t = recordedAt(n); return t !== null && t >= from && t <= to; }) : everyDelegated;
  // Busy time and parallel runs count whatever was running in the window, wherever it started.
  const intervals = everyDelegated.flatMap((n) => {
    if (n.start === null || n.end === null || n.end < n.start) return [];
    return [[Math.max(n.start, from), Math.min(n.end, to)] as [number, number]];
  }).filter(([a, b]) => b >= a);
  const merged = mergeIntervals(intervals);
  return {
    nodes: all.length, delegated: delegated.length,
    maxDepth: windowed ? Math.max(0, ...delegated.map((n) => n.depth)) : Math.max(...all.map((n) => n.depth)),
    maxFanout: Math.max(...all.map((n) => n.children.length)),
    peakParallel: peakConcurrency(intervals),
    busyMs: merged.reduce((s, [a, b]) => s + (b - a), 0),
    spanMs: merged.length ? merged[merged.length - 1][1] - merged[0][0] : 0,
    returned: delegated.filter((n) => n.agent?.returned === true).length,
    notReturned: delegated.filter((n) => n.agent?.returned === false).length,
    returnUnknown: delegated.filter((n) => !n.agent || n.agent.returned === null).length,
    openEnded: delegated.filter((n) => n.start === null || n.end === null || n.end < n.start).length,
    timed: delegated.length - delegated.filter((n) => n.start === null || n.end === null || n.end < n.start).length,
    wholeTree: everyDelegated.length,
  };
}

export function mergeIntervals(intervals: [number, number][]): [number, number][] {
  const sorted = intervals.map(([a, b]) => [a, b] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function peakConcurrency(intervals: [number, number][]): number {
  const events = intervals.flatMap(([a, b]) => [[a, 1], [b, -1]] as [number, number][]);
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

export interface TimeAxis {
  /** Percentage position of an instant on the compressed axis. */
  at: (t: number) => number;
  /** Positions of idle gaps shortened to keep brief runs visible. */
  gaps: number[];
  start: number;
  end: number;
}

/** Maps time to 0–100 while shortening idle gaps, so seconds-long runs stay visible in a tree that spans days. */
export function compressAxis(intervals: [number, number][], gapShare = 0.02): TimeAxis {
  const busy = mergeIntervals(intervals);
  if (!busy.length) return { at: () => 0, gaps: [], start: 0, end: 0 };
  const busyTotal = busy.reduce((s, [a, b]) => s + (b - a), 0);
  const cap = Math.max(1, busyTotal * gapShare);
  const segments: { from: number; to: number; x0: number; x1: number; gap: boolean }[] = [];
  let x = 0;
  busy.forEach(([a, b], i) => {
    if (i > 0) {
      const prev = busy[i - 1][1];
      const w = Math.min(a - prev, cap);
      segments.push({ from: prev, to: a, x0: x, x1: x + w, gap: a - prev > cap });
      x += w;
    }
    segments.push({ from: a, to: b, x0: x, x1: x + (b - a), gap: false });
    x += b - a;
  });
  const width = x || 1;
  const at = (t: number) => {
    if (t <= segments[0].from) return 0;
    for (const s of segments) {
      if (t <= s.to) {
        const f = s.to === s.from ? 0 : (t - s.from) / (s.to - s.from);
        return ((s.x0 + f * (s.x1 - s.x0)) / width) * 100;
      }
    }
    return 100;
  };
  return { at, gaps: segments.filter((s) => s.gap).map((s) => (((s.x0 + s.x1) / 2) / width) * 100), start: busy[0][0], end: busy[busy.length - 1][1] };
}

/** What a time and model filter leaves of a forest. A tree is in view when any of its threads ran inside the window. */
export interface ForestView { trees: TreeNode[]; standalone: number; threads: number }
export function forestInView(roots: TreeNode[], f: { since?: string; until?: string; model?: string }): ForestView {
  const since = f.since ? Date.parse(f.since) : -Infinity;
  const until = f.until ? Date.parse(f.until) : Infinity;
  const matches = (root: TreeNode) => {
    const all = flatten(root);
    const inRange = all.some((n) => n.start !== null && n.start >= since && n.start <= until);
    return inRange && (!f.model || all.some((n) => n.thread?.model === f.model || n.agent?.model === f.model));
  };
  const shown = roots.filter(matches);
  const trees = shown.filter((r) => r.children.length > 0);
  return { trees, standalone: shown.length - trees.length, threads: shown.length };
}
