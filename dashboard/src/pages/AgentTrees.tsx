import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ModelName } from '../components/model';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, Network, TriangleAlert } from 'lucide-react';
import { DataTable, type Column } from '../components/DataTable';
import { AppLink, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, Stat, StatRow, StatusBadge, Tag, Tokens, Unknown } from '../components/ui';
import type { ThreadTokens } from '../lib/analytics';
import { getEntities } from '../lib/api';
import { useAgents, useFilters, useThreads, useThreadTokens } from '../lib/data';
import { toAgent } from '../lib/entities';
import type { Entity } from '../lib/types';
import { fmtClock, fmtDateTime, fmtDay, fmtDuration, fmtInt } from '../lib/format';
import { useSettings } from '../lib/settings';
import { buildForest, compressAxis, flatten, forestInView, treeStats, type EdgeEvidence, type TreeNode } from '../lib/tree';
import { useUrl } from '../lib/url';

const EVIDENCE: Record<EdgeEvidence, string> = {
  both: 'Agent record and thread lineage agree',
  agent_record: 'Agent record (child_thread_id)',
  thread_lineage: 'Thread lineage (relationship: subagent)',
};

export default function AgentTrees() {
  const { params, hrefPatch } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  // Lineage is read whole per project: a time or model filter must never cut a parent out and orphan its children.
  const threads = useThreads({ project: f.project, instance: f.instance });
  const agents = useAgents({ project: f.project, instance: f.instance });
  const tokens = useThreadTokens({ project: f.project, instance: f.instance });
  const treeTokens = (root: TreeNode) => flatten(root).reduce<number | null>((s, n) => { const v = tokens.get(n.key)?.total; return v == null ? s : (s ?? 0) + v; }, null);

  const forest = useMemo(() => (threads.data && agents.data ? buildForest(threads.data.rows, agents.data.rows) : null), [threads.data, agents.data]);
  const view = useMemo(() => (forest ? forestInView(forest.roots, f) : null), [forest, f]);
  const trees = useMemo(() => (view?.trees ?? []).map((root) => ({ root, stats: treeStats(root, f) })), [view, f]);

  const selectedKey = params.get('root');
  const selected = trees.find((t) => t.root.key === selectedKey) ?? trees[0];
  const scanIncomplete = threads.data?.complete === false || agents.data?.complete === false;

  type Row = (typeof trees)[number];
  const columns: Column<Row>[] = [
    {
      key: 'title', header: 'Root thread', sort: (t) => t.root.title, className: 'cell-title',
      render: (t) => <AppLink className="row-link" href={hrefPatch({ root: t.root.key, node: null })} ariaCurrent={t === selected ? 'true' : undefined}><span>{t.root.title}</span></AppLink>,
    },
    { key: 'agents', header: 'Sub-agents', align: 'end', sort: (t) => t.stats.delegated, render: (t) => (t.stats.wholeTree !== t.stats.delegated ? <span title={`${fmtInt(t.stats.delegated)} started in this window, of ${fmtInt(t.stats.wholeTree)} in the whole tree`}>{fmtInt(t.stats.delegated)} <small className="fine">of {fmtInt(t.stats.wholeTree)}</small></span> : fmtInt(t.stats.delegated)) },
    { key: 'depth', header: 'Depth', align: 'end', sort: (t) => t.stats.maxDepth, render: (t) => fmtInt(t.stats.maxDepth) },
    { key: 'fanout', header: 'Fan-out', align: 'end', sort: (t) => t.stats.maxFanout, render: (t) => fmtInt(t.stats.maxFanout) },
    { key: 'parallel', header: 'Peak parallel', align: 'end', sort: (t) => t.stats.peakParallel, render: (t) => fmtInt(t.stats.peakParallel) },
    { key: 'busy', header: 'Busy time', align: 'end', sort: (t) => t.stats.busyMs, render: (t) => fmtDuration(t.stats.busyMs) },
    { key: 'tokens', header: 'Tokens', align: 'end', sort: (t) => treeTokens(t.root), render: (t) => <Tokens v={treeTokens(t.root)} /> },
    { key: 'start', header: 'Started', sort: (t) => t.root.start, render: (t) => (t.root.start ? <time dateTime={new Date(t.root.start).toISOString()}>{fmtDay(new Date(t.root.start).toISOString(), timezone)}</time> : <span className="fine">Unknown</span>) },
  ];

  const error = threads.error ?? agents.error;
  const totals = useMemo(() => ({
    agents: trees.reduce((s, t) => s + t.stats.delegated, 0),
    returned: trees.reduce((s, t) => s + t.stats.returned, 0),
    notReturned: trees.reduce((s, t) => s + t.stats.notReturned, 0),
    unknown: trees.reduce((s, t) => s + t.stats.returnUnknown, 0),
    deepest: Math.max(0, ...trees.map((t) => t.stats.maxDepth)),
  }), [trees]);

  return (
    <>
      <PageHeader title="Agent Trees" lead="Recorded parent links only." />
      {error ? <Panel><ErrorState error={error} onRetry={() => { threads.refetch(); agents.refetch(); }} /></Panel>
        : !forest ? <Panel><SkeletonRows rows={8} label="Loading agent trees" /></Panel>
          : !trees.length ? (
            <Panel>
              {f.since && Date.parse(f.since) > Date.now() ? (
                <EmptyState icon={<Network size={20} />} title="Not yet">
                  <p>This window starts later than now, so nothing is known about it yet.</p>
                </EmptyState>
              ) : (
              <EmptyState icon={<Network size={20} />} title="No delegation recorded in this view">
                <p>{view?.standalone ? `${fmtInt(view.standalone)} ${view.standalone === 1 ? 'thread' : 'threads'} in this view had no recorded sub-agents.` : 'No threads ran in this view.'} Widen the filters to see other trees.</p>
              </EmptyState>
              )}
            </Panel>
          ) : (
            <>
              <StatRow label="Delegation summary">
                <Stat label="Delegating threads" value={fmtInt(trees.filter((t) => t.stats.delegated > 0).length)} sub={`${fmtInt(view?.standalone ?? 0)} other threads in view did not delegate`} />
                <Stat label="Sub-agents" value={fmtInt(totals.agents)} sub={f.since || f.until ? 'Started in this window' : 'Each one a recorded parent link'} />
                <Stat label="Deepest level" value={fmtInt(totals.deepest)} />
                <Stat
                  label="Results delivered" value={`${fmtInt(totals.returned)} of ${fmtInt(totals.returned + totals.notReturned)}`}
                  sub={totals.unknown ? <>{fmtInt(totals.unknown)} <span className="unknown unknown-inline">not recorded</span></> : 'All recorded'}
                />
              </StatRow>

              {(forest.missingParents > 0 || forest.cycles > 0 || forest.conflicts > 0 || scanIncomplete) && (
                <div className="banner banner-soft" role="status">
                  <TriangleAlert size={15} aria-hidden="true" />
                  <span>
                    {forest.missingParents > 0 && `${fmtInt(forest.missingParents)} recorded parents are not imported, so those threads appear as roots. `}
                    {forest.cycles > 0 && `${fmtInt(forest.cycles)} links would form a loop and were not drawn. `}
                    {forest.conflicts > 0 && `${fmtInt(forest.conflicts)} threads have conflicting parent records; the agent record was used. `}
                    {scanIncomplete && 'Only the newest threads and agents were read, so older links may be missing.'}
                  </span>
                </div>
              )}

              <Panel title="Delegating threads" sub="Select one to inspect it below" flush>
                <DataTable rows={trees} columns={columns} rowKey={(t) => t.root.key} caption="Threads that delegated" prefix="tr" defaultSort={{ key: 'start', dir: 'desc' }} />
              </Panel>

              {selected && <TreeView key={selected.root.key} root={selected.root} tz={timezone} tokens={tokens} />}
            </>
          )}
    </>
  );
}

function TreeView({ root, tz, tokens }: { root: TreeNode; tz: string; tokens: Map<string, ThreadTokens> }) {
  const { params, set, hrefPage } = useUrl();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(() => flatten(root, collapsed), [root, collapsed]);
  const all = useMemo(() => flatten(root), [root]);
  const stats = useMemo(() => treeStats(root), [root]);
  const axis = useMemo(() => compressAxis(all.filter((n) => n.depth > 0).flatMap((n) => (n.start !== null && n.end !== null && n.end >= n.start ? [[n.start, n.end] as [number, number]] : []))), [all]);
  const nodeKey = params.get('node');
  const selected = all.find((n) => n.key === nodeKey) ?? root;
  const [cursor, setCursor] = useState(selected.key);
  const treeRef = useRef<HTMLDivElement>(null);
  const focusCursor = useRef(false);

  useEffect(() => {
    if (focusCursor.current) {
      focusCursor.current = false;
      treeRef.current?.querySelector<HTMLElement>('[tabindex="0"][role="treeitem"]')?.focus();
    }
  }, [cursor, rows]);

  const toggle = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const choose = (n: TreeNode) => { setCursor(n.key); set({ node: n.key === root.key ? null : n.key }, { replace: true }); };
  const move = (key: string) => { focusCursor.current = true; setCursor(key); };

  const onKey = (e: KeyboardEvent, n: TreeNode, i: number) => {
    const isOpen = n.children.length > 0 && !collapsed.has(n.key);
    const handlers: Record<string, () => void> = {
      ArrowDown: () => { if (rows[i + 1]) move(rows[i + 1].key); },
      ArrowUp: () => { if (rows[i - 1]) move(rows[i - 1].key); },
      Home: () => move(rows[0].key),
      End: () => move(rows[rows.length - 1].key),
      ArrowRight: () => { if (n.children.length && !isOpen) toggle(n.key); else if (isOpen) move(n.children[0].key); },
      ArrowLeft: () => {
        if (isOpen) { toggle(n.key); return; }
        for (let j = i - 1; j >= 0; j--) if (rows[j].depth < n.depth) { move(rows[j].key); return; }
      },
      Enter: () => choose(n),
      ' ': () => choose(n),
    };
    const h = handlers[e.key];
    if (h) { e.preventDefault(); h(); }
  };

  const hasTimes = axis.end > axis.start;
  const rootTokens = tokens.get(root.key)?.total ?? null;
  const childTokens = all.filter((n) => n.depth > 0).reduce<number | null>((s, n) => { const v = tokens.get(n.key)?.total; return v == null ? s : (s ?? 0) + v; }, null);
  const fullAgent = useQuery({
    queryKey: ['agent-full', selected.agent?.source_id],
    enabled: !!selected.agent,
    queryFn: async ({ signal }) => {
      const rows = await getEntities<Entity>('agents', new URLSearchParams({ id: selected.agent!.source_id, limit: '1', include_content: 'true' }), signal);
      const row = rows.find((r) => r.source_id === selected.agent!.source_id);
      return row ? toAgent(row) : null;
    },
  });
  const agentText = fullAgent.data ?? selected.agent;

  return (
    <div className="split split-tree">
      <Panel
        className="grow-3"
        title={root.title}
        sub={
          hasTimes
            ? <>Sub-agent timeline, {fmtDateTime(new Date(axis.start).toISOString(), tz)} to {fmtDateTime(new Date(axis.end).toISOString(), tz)}. {axis.gaps.length ? `Idle gaps are shortened (${fmtInt(axis.gaps.length)} marked).` : ''}</>
            : 'No completion times recorded, so no timeline can be drawn.'
        }
        flush
      >
        <div className="tree-stats">
          <span><b>{fmtInt(stats.delegated)}</b> sub-agents</span>
          <span><b>{fmtInt(stats.maxFanout)}</b> max fan-out</span>
          <span><b>{fmtInt(stats.peakParallel)}</b> peak parallel</span>
          <span><b>{fmtDuration(stats.busyMs)}</b> busy</span>
          {rootTokens !== null && <span><b><Tokens v={rootTokens} /></b> root tokens</span>}
          {childTokens !== null && <span><b><Tokens v={childTokens} /></b> sub-agent tokens</span>}
          {stats.openEnded > 0 && <span><b>{fmtInt(stats.openEnded)}</b> <span className="unknown unknown-inline">no end time</span></span>}
        </div>
        <div className="tree-axis" aria-hidden="true">
          <span />
          <span className="tree-axis-track">{axis.gaps.map((g) => <i key={g} style={{ insetInlineStart: `${g}%` }} />)}</span>
          <span />
        </div>
        <div ref={treeRef} role="tree" aria-label={`Delegation tree for ${root.title}`} className="tree">
          {rows.map((n, i) => {
            const isParent = n.children.length > 0;
            const open = isParent && !collapsed.has(n.key);
            const left = n.start !== null && hasTimes ? axis.at(n.start) : null;
            const right = n.end !== null && n.start !== null && n.end >= n.start && hasTimes ? axis.at(n.end) : null;
            return (
              <div
                key={n.key}
                role="treeitem"
                aria-level={n.depth + 1}
                aria-expanded={isParent ? open : undefined}
                aria-selected={selected.key === n.key}
                tabIndex={cursor === n.key ? 0 : -1}
                className={selected.key === n.key ? 'tree-row is-selected' : 'tree-row'}
                style={{ '--depth': n.depth } as React.CSSProperties}
                onClick={() => choose(n)}
                onFocus={() => setCursor(n.key)}
                onKeyDown={(e) => onKey(e, n, i)}
              >
                <span className="tree-label">
                  {isParent ? (
                    <button type="button" className="tree-caret" tabIndex={-1} aria-hidden="true" onClick={(e) => { e.stopPropagation(); toggle(n.key); }}>
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  ) : <span className="tree-leaf" aria-hidden="true" />}
                  <span className="tree-title">{n.title}</span>
                </span>
                <span className="tree-track" aria-hidden="true">
                  {n.depth === 0 && hasTimes && <span className="tree-bar tree-bar-envelope" style={{ insetInlineStart: 0, inlineSize: '100%' }} />}
                  {n.depth > 0 && left !== null && (right !== null
                    ? <span className={n.agent?.status === 'failed' ? 'tree-bar tree-bar-failed' : 'tree-bar'} style={{ insetInlineStart: `${left}%`, inlineSize: `${Math.max(0.5, right - left)}%` }} />
                    : <span className="tree-bar tree-bar-open" style={{ insetInlineStart: `${left}%`, inlineSize: '3%' }} />)}
                </span>
                <span className="tree-time">
                  {n.depth === 0 ? <span className="fine">{isParent ? `${fmtInt(n.children.length)} direct` : ''}</span>
                    : n.agent?.duration != null ? fmtDuration(n.agent.duration)
                      : <Unknown label="No end" why="No completion time recorded for this sub-agent." />}
                </span>
              </div>
            );
          })}
        </div>
        <p className="fine pad tree-legend">
          <span className="tree-key" /> Recorded run
          <span className="tree-key tree-key-open" /> No recorded end
          <span className="tree-key tree-key-envelope" /> Span of the root's sub-agents. The root's own run time is not recorded here.
        </p>
      </Panel>

      <Panel className="grow-1 tree-detail" title={selected.depth === 0 ? 'Root thread' : 'Sub-agent'} sub={selected.title}>
        <dl className="facts">
          <div><dt>Model</dt><dd>{selected.agent?.model ?? selected.thread?.model ? <ModelName model={String(selected.agent?.model ?? selected.thread?.model)} /> : <Unknown label="Unknown" />}</dd></div>
          <div><dt>Status</dt><dd>{selected.depth === 0 && !selected.agent ? <span className="fine">See thread runs</span> : <StatusBadge status={selected.agent?.status} />}</dd></div>
          <div><dt>Started</dt><dd>{selected.start ? `${fmtDay(new Date(selected.start).toISOString(), tz)} ${fmtClock(new Date(selected.start).toISOString(), tz)}` : <Unknown label="Unknown" />}</dd></div>
          {selected.depth > 0 && <div><dt>Time</dt><dd>{selected.agent?.duration != null ? fmtDuration(selected.agent.duration) : <Unknown label="Unknown" why="No completion time recorded." />}</dd></div>}
          {selected.depth > 0 && <div><dt>Result delivered</dt><dd>{selected.agent?.returned == null ? <Unknown label="Not recorded" why="No explicit delivery record. This does not mean the result was lost." /> : selected.agent.returned ? <Tag>Acknowledged</Tag> : <Tag tone="warn">Not acknowledged</Tag>}</dd></div>}
          <div><dt>Tokens</dt><dd><Tokens v={tokens.get(selected.key)?.total} why="No provider turn with reported usage is recorded for this thread." /></dd></div>
          {selected.evidence && <div><dt>Edge evidence</dt><dd>{EVIDENCE[selected.evidence]}</dd></div>}
          {selected.missingParent && <div><dt>Parent</dt><dd><Tag tone="warn">Recorded, not imported</Tag></dd></div>}
          {selected.depth === 0 && <div><dt>Direct sub-agents</dt><dd>{fmtInt(selected.children.length)}</dd></div>}
        </dl>
        {agentText?.task && <TextBlock label="Task" text={agentText.task} />}
        {agentText?.result && <TextBlock label="Result" text={agentText.result} />}
        {selected.thread && <AppLink className="btn" href={hrefPage('Threads', { id: selected.thread.source_id })}><ExternalLink size={14} aria-hidden="true" /> Open thread</AppLink>}
      </Panel>
    </div>
  );
}

function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <details className="agent-part" open={label === 'Result'}>
      <summary>{label}</summary>
      <div className="message-text message-small">{text}</div>
    </details>
  );
}
