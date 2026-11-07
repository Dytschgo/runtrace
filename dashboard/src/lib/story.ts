import { contentField, durationMs, parseContent, toAgent, toRun, toTurn, type AgentRow, type ThreadRow } from './entities';
import { cleanText, fmtDuration } from './format';
import { flatten, mergeIntervals, type TreeNode } from './tree';
import type { Entity } from './types';

/**
 * The story of one thread: everything recorded for it laid on one compressed clock, so it can be played back.
 * Nothing here is inferred. A lane exists because an agent record or a thread lineage record exists, a tick exists
 * because an event was captured, and anything the record lacks is reported in `gaps` rather than drawn.
 */

export interface StoryAxis {
  /** First and last recorded instant. */
  start: number;
  end: number;
  /** Fraction 0–1 of an instant on the compressed clock. */
  toX: (t: number) => number;
  /** The instant at a fraction of the compressed clock. */
  toT: (x: number) => number;
  /** Idle stretches that were shortened, with their real length. */
  gaps: { x: number; from: number; to: number }[];
  /** Real time covered, and the compressed time the clock shows. */
  spanMs: number;
  compressedMs: number;
}

interface Segment { from: number; to: number; x0: number; x1: number; gap: boolean }

/** Maps time to 0–1 while shortening idle gaps, so a run of seconds stays visible in a thread that lasted days. */
export function storyAxis(intervals: [number, number][], gapShare = 0.04): StoryAxis {
  const busy = mergeIntervals(intervals.map(([a, b]) => [a, Math.max(b, a + 1000)] as [number, number]));
  if (!busy.length) return { start: 0, end: 0, toX: () => 0, toT: () => 0, gaps: [], spanMs: 0, compressedMs: 0 };
  const busyTotal = busy.reduce((s, [a, b]) => s + (b - a), 0);
  const cap = Math.max(1000, busyTotal * gapShare);
  const segments: Segment[] = [];
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
  const toX = (t: number) => {
    if (t <= segments[0].from) return 0;
    for (const s of segments) {
      if (t <= s.to) return (s.x0 + ((t - s.from) / (s.to - s.from || 1)) * (s.x1 - s.x0)) / width;
    }
    return 1;
  };
  const toT = (f: number) => {
    const px = Math.min(1, Math.max(0, f)) * width;
    for (const s of segments) {
      if (px <= s.x1) return s.from + ((px - s.x0) / (s.x1 - s.x0 || 1)) * (s.to - s.from);
    }
    return segments[segments.length - 1].to;
  };
  return {
    start: busy[0][0], end: busy[busy.length - 1][1], toX, toT,
    gaps: segments.filter((s) => s.gap).map((s) => ({ x: (s.x0 + s.x1) / 2 / width, from: s.from, to: s.to })),
    spanMs: busy[busy.length - 1][1] - busy[0][0], compressedMs: width,
  };
}

export type StoryEventKind = 'prompt' | 'answer' | 'tool' | 'run_start' | 'run_end' | 'turn' | 'spawn' | 'return' | 'external';

export interface StoryEvent {
  id: string;
  kind: StoryEventKind;
  t: number;
  x: number;
  /** The lane this happened on: the thread itself, or a sub-agent. */
  lane: string;
  failed: boolean;
  /** One sentence for the story log. Events with no line are drawn but not narrated. */
  line: string | null;
  /** Captured text behind the line, as stored: a prompt, an answer, a task or a result. */
  text: string | null;
  truncated: boolean;
  model: string | null;
  status: string | null;
  /** For provider turns: the complete total, or null when the provider did not report one. */
  tokens: number | null;
  durationMs: number | null;
  entity: Entity | null;
}

export interface Lane {
  key: string;
  node: TreeNode;
  /** Row 0 is the thread; sub-agents share rows when their runs do not overlap. */
  row: number;
  depth: number;
  parent: string | null;
  title: string;
  model: string | null;
  status: string | null;
  start: number | null;
  end: number | null;
  x0: number | null;
  x1: number | null;
  /** True when no completion time was recorded. The lane is drawn as a hatched stub, never implied to the end. */
  open: boolean;
  returned: boolean | null;
  duration: number | null;
  /** The thread this lane runs in, when it was imported. */
  thread: string | null;
  /** Every task sent to this lane, oldest first. A delegated thread can be sent more than one. */
  sends: Send[];
}

export interface Send { agent: AgentRow | null; start: number; end: number | null; open: boolean; x0: number; x1: number }

export interface RunSegment { id: string; x0: number; x1: number; start: number; end: number | null; model: string | null; status: string | null; open: boolean }

export interface StoryGaps {
  agentsNoEnd: number;
  agentsDeliveryUnknown: number;
  runsNoEnd: number;
  toolsNoStatus: number;
  turns: number;
  turnsWithoutTotal: number;
  textCut: number;
  withheld: number;
}

export interface Story {
  axis: StoryAxis;
  lanes: Lane[];
  rows: number;
  runs: RunSegment[];
  events: StoryEvent[];
  /** Events with a sentence, in order. */
  narrated: StoryEvent[];
  /** Running totals before and including each event index, for O(1) counters at any playhead. */
  counts: StoryCounts;
  gaps: StoryGaps;
  /** Tasks sent to sub-agents, counting every send. */
  sends: number;
  firstPrompt: string | null;
}

export interface StoryCounts {
  prompts: Int32Array; answers: Int32Array; tools: Int32Array; toolsFailed: Int32Array;
  spawned: Int32Array; finished: Int32Array; agentsFailed: Int32Array; tokens: Float64Array; turnsWithTotal: Int32Array;
}

const ms = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const firstLine = (s: string | null | undefined, n = 160) => {
  if (!s) return null;
  const line = cleanText(s).trim().split('\n').find((l) => l.trim()) ?? '';
  return line.length > n ? `${line.slice(0, n).trimEnd()}…` : line;
};

/** A quoted preview for a story line. */
const quote = (s: string | null, n = 110) => {
  const l = firstLine(s, n);
  return l ? ` “${l}”` : '';
};

/**
 * T3 tells a thread that a delegated task finished by sending it a message, so it is recorded as a prompt.
 * It is not something you asked, and its long internal id means nothing to read, so it is named for what it is.
 */
export function delegateReport(text: string | null): string | null {
  const m = text?.match(/^Delegated task \S+(?: \((.*?)\))?(?: \[([a-z_]+)\])?:?/);
  if (!m) return null;
  const who = m[1] ? `“${m[1]}”` : 'A delegated task';
  return m[2] === 'completed' || !m[2] ? `${who} reported back` : `${who} reported back: ${m[2].replaceAll('_', ' ')}`;
}

const FAILED = new Set(['failed', 'cancelled', 'interrupted']);

/** Packs intervals onto rows, first fit by start. Returns the row of each, and the row count. */
export function packRows(items: { x0: number; x1: number }[]): { rows: number[]; count: number } {
  const order = items.map((it, i) => i).sort((a, b) => items[a].x0 - items[b].x0 || items[a].x1 - items[b].x1);
  const rowEnds: number[] = [];
  const rows = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const { x0, x1 } = items[i];
    let r = rowEnds.findIndex((end) => end <= x0);
    if (r < 0) { r = rowEnds.length; rowEnds.push(x1); } else rowEnds[r] = x1;
    rows[i] = r;
  }
  return { rows, count: rowEnds.length };
}

/** A node for a thread that is not in the forest: its sub-agents come from the timeline alone. */
export function fallbackRoot(id: string, thread: ThreadRow | null, agentEntities: Entity[]): TreeNode {
  const root: TreeNode = { key: id, title: thread?.title ?? 'Thread', thread, agent: null, children: [], depth: 0, evidence: null, missingParent: null, cycle: false, start: ms(thread?.occurred_at), end: null };
  for (const e of agentEntities) {
    const a = toAgent(e);
    root.children.push({
      key: a.child ?? `agent:${a.source_id}`, title: a.task?.split('\n')[0].slice(0, 120) || 'Sub-agent', thread: null, agent: a, children: [], depth: 1,
      evidence: 'agent_record', missingParent: null, cycle: false, start: ms(a.started) ?? ms(a.occurred_at), end: ms(a.completed),
    });
  }
  root.children.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  return root;
}

export function findNode(roots: TreeNode[], key: string): TreeNode | null {
  for (const r of roots) for (const n of flatten(r)) if (n.key === key) return n;
  return null;
}

const STUB = 0.025;

export function buildStory(root: TreeNode, events: Entity[], agentsByChild?: Map<string, AgentRow>): Story {
  const own = events.filter((e) => e.kind !== 'thread');
  const nodes = flatten(root);
  const parentOf = new Map<string, string>();
  for (const n of nodes) for (const c of n.children) parentOf.set(c.key, n.key);

  // The clock covers every recorded instant: runs, sub-agent runs and single events.
  const intervals: [number, number][] = [];
  const runEntities = own.filter((e) => e.kind === 'run');
  for (const e of runEntities) {
    const a = ms(e.data?.started_at) ?? ms(e.occurred_at);
    const b = ms(e.data?.completed_at);
    if (a !== null) intervals.push([a, b !== null && b >= a ? b : a]);
  }
  for (const n of nodes) {
    if (n.start !== null) intervals.push([n.start, n.end !== null && n.end >= n.start ? n.end : n.start]);
  }
  for (const e of own) {
    const t = ms(e.occurred_at);
    if (t !== null) intervals.push([t, t]);
  }
  // One delegated thread can receive several tasks (a send after the first). Every agent record for a lane is kept.
  const subs = nodes.filter((n) => n.key !== root.key);
  const nodeKeys = new Set(nodes.map((n) => n.key));
  const sendsByLane = new Map<string, AgentRow[]>();
  const addSend = (key: string, a: AgentRow) => {
    const list = sendsByLane.get(key) ?? [];
    if (!list.some((s) => s.source_id === a.source_id)) list.push(a);
    sendsByLane.set(key, list);
  };
  for (const n of subs) {
    const a = n.agent ?? (n.thread ? agentsByChild?.get(n.thread.source_id) ?? null : null);
    if (a) addSend(n.key, a);
  }
  for (const e of own) {
    if (e.kind !== 'agent') continue;
    const child = typeof e.data?.child_thread_id === 'string' ? e.data.child_thread_id : `agent:${e.source_id}`;
    if (nodeKeys.has(child)) addSend(child, toAgent(e));
  }
  for (const list of sendsByLane.values()) {
    list.sort((p, q) => (ms(p.started) ?? ms(p.occurred_at) ?? 0) - (ms(q.started) ?? ms(q.occurred_at) ?? 0));
    for (const a of list) {
      const s = ms(a.started) ?? ms(a.occurred_at);
      const c = ms(a.completed);
      if (s !== null) intervals.push([s, c !== null && c >= s ? c : s]);
    }
  }
  const axis = storyAxis(intervals);

  const sendsOf = (n: TreeNode): Send[] => (sendsByLane.get(n.key) ?? []).flatMap((a) => {
    const s = ms(a.started) ?? ms(a.occurred_at);
    if (s === null) return [];
    const c = ms(a.completed);
    const open = c === null || c < s;
    const x0 = axis.toX(s);
    return [{ agent: a, start: s, end: open ? null : c, open, x0, x1: open ? Math.min(1, x0 + STUB) : Math.max(axis.toX(c), x0 + 0.002) }];
  });
  const laneSends = subs.map(sendsOf);
  // Sub-agents share rows when they do not overlap, so a thread with hundreds stays a few rows tall.
  const spans = subs.map((n, i) => {
    const sends = laneSends[i];
    if (sends.length) return { x0: sends[0].x0, x1: Math.max(...sends.map((s) => s.x1)) };
    const x0 = n.start !== null ? axis.toX(n.start) : 0;
    const x1 = n.end !== null && n.start !== null && n.end >= n.start ? Math.max(axis.toX(n.end), x0 + 0.002) : Math.min(1, x0 + STUB);
    return { x0, x1 };
  });
  const packed = packRows(spans);
  const laneOf = (n: TreeNode, row: number, x0: number | null, x1: number | null, sends: Send[]): Lane => {
    const last = sends[sends.length - 1]?.agent ?? n.agent ?? (n.thread ? agentsByChild?.get(n.thread.source_id) ?? null : null);
    const start = sends.length ? sends[0].start : n.start;
    const latest = sends.length ? sends[sends.length - 1] : null;
    const end = latest ? latest.end : n.end;
    return {
      key: n.key, node: n, row, depth: n.depth - root.depth, parent: parentOf.get(n.key) ?? null, title: n.title,
      model: last?.model ?? n.thread?.model ?? null, status: last?.status ?? null, start, end, x0, x1, sends,
      open: start !== null && (latest ? latest.open : end === null || end < start), returned: last?.returned ?? null,
      duration: sends.length ? sends.reduce<number | null>((s, x) => (x.end === null ? s : (s ?? 0) + (x.end - x.start)), null) : last?.duration ?? null,
      thread: n.thread?.source_id ?? null,
    };
  };
  const lanes: Lane[] = [laneOf(root, 0, 0, 1, []), ...subs.map((n, i) => laneOf(n, packed.rows[i] + 1, subs[i].start === null && !laneSends[i].length ? null : spans[i].x0, subs[i].start === null && !laneSends[i].length ? null : spans[i].x1, laneSends[i]))];
  const laneKeys = new Set(lanes.map((l) => l.key));

  const runs: RunSegment[] = runEntities.flatMap((e) => {
    const r = toRun(e);
    const a = ms(r.started) ?? ms(r.occurred_at);
    if (a === null) return [];
    const b = ms(r.completed);
    const open = b === null || b < a;
    const x0 = axis.toX(a);
    return [{ id: e.id, x0, x1: open ? Math.min(1, x0 + STUB) : Math.max(axis.toX(b), x0 + 0.002), start: a, end: open ? null : b, model: r.requested, status: r.status, open }];
  });

  const out: StoryEvent[] = [];
  const push = (ev: Omit<StoryEvent, 'x'>) => out.push({ ...ev, x: axis.toX(ev.t) });
  const gaps: StoryGaps = { agentsNoEnd: 0, agentsDeliveryUnknown: 0, runsNoEnd: 0, toolsNoStatus: 0, turns: 0, turnsWithoutTotal: 0, textCut: 0, withheld: 0 };

  for (const e of own) {
    const t = ms(e.occurred_at);
    if (t === null) continue;
    const d = e.data ?? {};
    const truncated = d.content_truncated === true;
    const base = { id: e.id, t, lane: root.key, failed: false, truncated, model: typeof d.model === 'string' ? d.model : null, status: typeof d.status === 'string' ? d.status : null, tokens: null, durationMs: null, entity: e };
    if (e.kind === 'prompt' || e.kind === 'answer') {
      const text = typeof d.content_redacted === 'string' && d.content_redacted ? cleanText(d.content_redacted) : null;
      if (!text) gaps.withheld++;
      else if (truncated) gaps.textCut++;
      const who = e.kind === 'prompt' ? 'You asked' : `${base.model ?? 'The agent'} answered`;
      const report = e.kind === 'prompt' ? delegateReport(text) : null;
      push({ ...base, kind: e.kind, line: report ?? (text ? `${who}${quote(text)}` : `${who}, but the text was withheld by capture policy`), text });
    } else if (e.kind === 'tool') {
      const failed = d.status === 'failed' || (typeof d.exit_code === 'number' && d.exit_code !== 0);
      if (!d.status) gaps.toolsNoStatus++;
      const name = typeof d.tool_name === 'string' ? d.tool_name : 'A tool';
      const c = parseContent(d);
      const args = contentField(c.fields?.arguments) ?? contentField(c.fields?.diff) ?? null;
      const exit = typeof d.exit_code === 'number' && d.exit_code !== 0 ? ` with exit code ${d.exit_code}` : '';
      push({ ...base, kind: 'tool', failed, durationMs: durationMs(d), line: failed ? `${name} failed${exit}${quote(args, 80)}` : null, text: args });
    } else if (e.kind === 'run') {
      const r = toRun(e);
      const a = ms(r.started) ?? t;
      const b = ms(r.completed);
      const failed = FAILED.has(r.status ?? '');
      if (b === null) gaps.runsNoEnd++;
      push({ ...base, kind: 'run_start', t: a, line: null, text: null, model: r.requested });
      if (b !== null && b >= a) push({ ...base, id: `${e.id}:end`, kind: 'run_end', t: b, failed, durationMs: b - a, model: r.requested, line: failed ? `The turn ${r.status} after ${fmtDuration(b - a)}` : null, text: null });
    } else if (e.kind === 'model_turn') {
      const turn = toTurn(e);
      gaps.turns++;
      if (turn.total === null) gaps.turnsWithoutTotal++;
      push({ ...base, kind: 'turn', tokens: turn.total, durationMs: turn.duration, model: turn.model, line: null, text: null });
    } else if (e.kind === 'external_request') {
      push({ ...base, kind: 'external', line: 'An external request arrived', text: null });
    } else if (e.kind === 'agent') {
      // Lanes come from the tree. The event is kept only for a sub-agent the tree does not know.
      const child = typeof d.child_thread_id === 'string' ? d.child_thread_id : `agent:${e.source_id}`;
      if (laneKeys.has(child)) continue;
      const a = toAgent(e);
      push({ ...base, kind: 'spawn', failed: false, model: a.model, status: a.status, line: `Delegated to ${a.model ?? 'a sub-agent'}${quote(a.task)}`, text: a.task });
    }
  }

  let sendsTotal = 0;
  for (const l of lanes.slice(1)) {
    const parentLane = l.parent && laneKeys.has(l.parent) ? l.parent : root.key;
    const sends = l.sends.length ? l.sends : l.start !== null ? [{ agent: l.node.agent, start: l.start, end: l.open ? null : l.end, open: l.open, x0: l.x0 ?? 0, x1: l.x1 ?? 0 }] : [];
    sends.forEach((s, i) => {
      const a = s.agent;
      const who = a?.model ?? 'a sub-agent';
      sendsTotal++;
      push({
        id: `${l.key}:spawn:${i}`, kind: 'spawn', t: s.start, lane: parentLane, failed: false, truncated: false, model: a?.model ?? null, status: a?.status ?? null, tokens: null, durationMs: null, entity: null,
        line: i === 0 ? `Delegated to ${who}: ${l.title}` : `Sent a follow-up task to ${who}${quote(a?.task ?? null)}`, text: a?.task ?? null,
      });
      if (s.open) gaps.agentsNoEnd++;
      if (a && a.returned === null) gaps.agentsDeliveryUnknown++;
      if (s.end !== null && !s.open) {
        const failed = FAILED.has(a?.status ?? '');
        const verb = a?.status === 'completed' ? 'finished' : a?.status ?? 'ended';
        push({
          id: `${l.key}:return:${i}`, kind: 'return', t: s.end, lane: l.key, failed, truncated: false, model: a?.model ?? null, status: a?.status ?? null, tokens: null, durationMs: s.end - s.start, entity: null,
          line: `${who} ${verb} after ${fmtDuration(s.end - s.start)}${quote(a?.result ?? null)}`, text: a?.result ?? null,
        });
      }
    });
  }

  out.sort((p, q) => p.t - q.t || rank(p.kind) - rank(q.kind));
  const n = out.length;
  const counts: StoryCounts = {
    prompts: new Int32Array(n), answers: new Int32Array(n), tools: new Int32Array(n), toolsFailed: new Int32Array(n),
    spawned: new Int32Array(n), finished: new Int32Array(n), agentsFailed: new Int32Array(n), tokens: new Float64Array(n), turnsWithTotal: new Int32Array(n),
  };
  let prompts = 0, answers = 0, tools = 0, toolsFailed = 0, spawned = 0, finished = 0, agentsFailed = 0, tokens = 0, turnsWithTotal = 0;
  out.forEach((ev, i) => {
    if (ev.kind === 'prompt') prompts++;
    else if (ev.kind === 'answer') answers++;
    else if (ev.kind === 'tool') { tools++; if (ev.failed) toolsFailed++; }
    else if (ev.kind === 'spawn') spawned++;
    else if (ev.kind === 'return') { finished++; if (ev.failed) agentsFailed++; }
    else if (ev.kind === 'turn' && ev.tokens !== null) { tokens += ev.tokens; turnsWithTotal++; }
    counts.prompts[i] = prompts; counts.answers[i] = answers; counts.tools[i] = tools; counts.toolsFailed[i] = toolsFailed;
    counts.spawned[i] = spawned; counts.finished[i] = finished; counts.agentsFailed[i] = agentsFailed; counts.tokens[i] = tokens; counts.turnsWithTotal[i] = turnsWithTotal;
  });

  return {
    axis, lanes, rows: packed.count + 1, runs, events: out, narrated: out.filter((e) => e.line), counts, gaps, sends: sendsTotal,
    firstPrompt: out.find((e) => e.kind === 'prompt')?.text ?? null,
  };
}

const ORDER: Record<StoryEventKind, number> = { prompt: 0, run_start: 1, spawn: 2, tool: 3, turn: 4, external: 5, answer: 6, return: 7, run_end: 8 };
const rank = (k: StoryEventKind) => ORDER[k];

/** Number of events at or before an instant. */
export function indexAt(events: StoryEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Lanes running at an instant: started, and not yet ended. An open-ended lane counts only while its stub lasts. */
export function activeLanes(lanes: Lane[], t: number, axis: StoryAxis): Lane[] {
  const x = axis.toX(t);
  return lanes.filter((l) => l.row > 0 && l.x0 !== null && l.x1 !== null && l.x0 <= x && (l.open ? x < l.x1 : (l.end ?? Infinity) > t));
}

/** The latest event of a kind at or before an index. */
export function latestBefore(events: StoryEvent[], index: number, kind: StoryEventKind): StoryEvent | null {
  for (let i = Math.min(index, events.length) - 1; i >= 0; i--) if (events[i].kind === kind) return events[i];
  return null;
}
