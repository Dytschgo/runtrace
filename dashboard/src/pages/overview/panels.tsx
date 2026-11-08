import { useMemo, type ComponentType } from 'react';
import { Bot, MessageSquare, MessageSquareReply, MessagesSquare, Play, Repeat2, Terminal, XCircle } from 'lucide-react';
import { Counter } from '../../components/motion';
import { ToolName } from '../../components/model';
import { AppLink, Async, EmptyState, ErrorState, NoRecords, NotLoaded, Panel, plural, RankedBars, Segmented, SkeletonRows, Sparkline, Tag, Tokens, Unknown } from '../../components/ui';
import { delta, toolStats, type ToolStat } from '../../lib/analytics';
import type { useAgents, useThreads, useToolAggregates, useToolScan } from '../../lib/data';
import { dataOf, type Load } from '../../lib/load';
import type { ThreadRow, TurnRow } from '../../lib/entities';
import type { Filters } from '../../lib/filters';
import { fmtCompact, fmtDuration, fmtInt, fmtPct, fmtRelative, isKnown } from '../../lib/format';
import { modelIcon } from '../../lib/icons';
import { seriesColor } from '../../lib/modelColors';
import { forestInView, treeStats, type Forest } from '../../lib/tree';
import { useUrl, type PageName } from '../../lib/url';
import { ChangeArrow, signedPct } from './parts';

/** What one thread did inside the window. */
export interface ThreadActivity { last: string; turns: number; tokens: number | null; missing: boolean }

interface Tile { label: string; kind: string; page: PageName; icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>; hint?: string }

/** The row of totals under the chart, each compared with the period before when capture covers it. */
export function KeyTotals({ counts, previous, comparable, windowed, turnsSeen, unscopable, unknown, stale }: {
  counts: Load<Record<string, number>>; previous: Record<string, number> | undefined; comparable: boolean;
  windowed: boolean; turnsSeen: boolean; unscopable: boolean; unknown: { title: string; text: string } | null; stale: boolean;
}) {
  const { hrefPage } = useUrl();
  const c = dataOf(counts) ?? {};
  const perPrompt = (kind: string) => (isKnown(c[kind]) && c.prompt ? `${(c[kind] / c.prompt).toFixed(1)} per prompt` : undefined);
  const tiles: Tile[] = [
    { label: 'Prompts', kind: 'prompt', page: 'Activity', icon: MessageSquare },
    { label: 'Answers', kind: 'answer', page: 'Activity', icon: MessageSquareReply, hint: perPrompt('answer') },
    { label: 'Runs', kind: 'run', page: 'Models', icon: Play },
    { label: 'Provider turns', kind: 'model_turn', page: 'Models', icon: Repeat2 },
    { label: windowed ? 'Threads started' : 'Threads', kind: 'thread', page: 'Threads', icon: MessagesSquare },
    { label: 'Sub-agents', kind: 'agent', page: 'Agent Trees', icon: Bot, hint: isKnown(c.agent) && c.thread ? `${fmtPct(c.agent / c.thread)} of threads` : undefined },
    { label: 'Tool calls', kind: 'tool', page: 'Tool Calls', icon: Terminal, hint: perPrompt('tool') },
  ];
  // An older service has no provider turns; a tile would read as zero work, so it is left out.
  const visible = tiles.filter((t) => t.kind !== 'model_turn' || isKnown(c.model_turn) || turnsSeen);
  return (
    <section className="stats" aria-label="Key totals" data-stale={stale ? 'true' : undefined}>
      {visible.map((t) => {
        // The service never counts session-log hours as provider turns.
        const value = c[t.kind];
        const before = previous?.[t.kind] ?? 0;
        const d = comparable && previous && isKnown(value) ? delta(value, before) : null;
        const Icon = t.icon;
        return (
          <article key={t.kind} className="tile" title={t.hint}>
            <h2><AppLink className="tile-link" href={hrefPage(t.page)}><Icon size={14} aria-hidden="true" />{t.label}</AppLink></h2>
            {counts.state === 'loading' ? <div className="skeleton tile-skeleton" role="status" aria-label={`Loading ${t.label}`} /> : counts.state === 'failed' ? <strong><NotLoaded /></strong> : <strong title={isKnown(value) ? fmtInt(value) : undefined}>{unscopable ? <Unknown label="Unknown" why="Records that name no model cannot be counted on their own." /> : unknown && !value ? <Unknown label="Unknown" why={unknown.text} /> : isKnown(value) ? <Counter value={value} /> : '0'}</strong>}
            {d !== null && (
              <span className="delta" title="Compared with the same length of time just before">
                <ChangeArrow change={d} />
                {signedPct(d)} <span className="sr-only">compared with the previous period</span>
              </span>
            )}
          </article>
        );
      })}
    </section>
  );
}

/** The threads that ran in the window, most recent or biggest first, each with its turns, tokens and a sparkline. */
export function RecentThreadsPanel({ threads, inWindow, activity, turns, agentsByThread, slots, projectName }: {
  threads: ReturnType<typeof useThreads>; inWindow: ThreadRow[]; activity: Map<string, ThreadActivity>; turns: TurnRow[];
  agentsByThread: Map<string, number>; slots: Map<string, string>; projectName: (id: string) => string | null;
}) {
  const { hrefPage, params, set } = useUrl();
  const sort = params.get('threads') === 'tokens' ? 'tokens' : 'recent';
  const recent = useMemo(() => {
    const lastSeen = (id: string, fallback: string) => activity.get(id)?.last ?? fallback;
    if (sort === 'tokens') return [...inWindow].sort((a, b) => (activity.get(b.source_id)?.tokens ?? 0) - (activity.get(a.source_id)?.tokens ?? 0)).slice(0, 8);
    return inWindow.filter((t) => t.type !== 'child').sort((a, b) => lastSeen(b.source_id, b.occurred_at).localeCompare(lastSeen(a.source_id, a.occurred_at))).slice(0, 6);
  }, [inWindow, sort, activity]);
  const sparks = useMemo(() => {
    const wanted = new Set(recent.map((t) => t.source_id));
    const byThread = new Map<string, { at: string; v: number }[]>();
    for (const t of turns) {
      // A sparkline only draws what was reported, so a thread with no totals has no line rather than a flat zero.
      if (!wanted.has(t.thread_id) || t.total === null) continue;
      const list = byThread.get(t.thread_id) ?? [];
      list.push({ at: t.occurred_at, v: t.total });
      byThread.set(t.thread_id, list);
    }
    const out = new Map<string, number[]>();
    for (const [id, list] of byThread) out.set(id, list.sort((a, b) => a.at.localeCompare(b.at)).map((l) => l.v));
    return out;
  }, [recent, turns]);
  return (
    <Panel
      title={sort === 'tokens' ? 'Biggest threads' : 'Recent threads'}
      action={
        <>
          <Segmented label="Sort threads" value={sort} options={[{ value: 'recent', label: 'Recent' }, { value: 'tokens', label: 'Biggest' }]} onChange={(v) => set({ threads: v === 'recent' ? null : v })} />
          <AppLink className="link" href={hrefPage('Threads')}>All threads</AppLink>
        </>
      }
    >
      <Async query={threads} skeleton={<SkeletonRows label="Loading threads" />} isEmpty={() => !recent.length} empty={<NoRecords compact />} compact>
        {() => (
          <ul className="trace-rows">
            {recent.map((t, i) => {
              const spark = sparks.get(t.source_id);
              const did = activity.get(t.source_id);
              const kids = agentsByThread.get(t.source_id) ?? 0;
              const Icon = modelIcon(t.model);
              const color = t.model ? seriesColor(slots.get(t.model)) : seriesColor(undefined);
              return (
                <li key={t.id} style={{ '--i': i, color } as React.CSSProperties}>
                  <Icon size={15} aria-hidden="true" />
                  <span className="trace-row-title">
                    <AppLink className="list-title" href={hrefPage('Threads', { id: t.source_id })}>{t.title}</AppLink>
                    <small>
                      {projectName(t.project_id) ?? 'Project not imported'}
                      {t.model && <span className="mono"> · {t.model}</span>}
                      {kids > 0 && <> · <Tag>{plural(kids, 'sub-agent')}</Tag></>}
                    </small>
                  </span>
                  <span className="trace-row-num" title="Provider turns in this window">{did ? fmtInt(did.turns) : <Unknown label="n/a" why="No provider turns were recorded for this thread in this window." />}</span>
                  <span className="trace-row-num trace-row-tokens">{did?.missing && did.tokens !== null && <span title="Some turns reported no total">≥ </span>}<Tokens v={did?.tokens ?? null} why="No provider reported a token total for this thread in this window." /></span>
                  <span className="trace-row-spark">{spark && <Sparkline values={spark} />}</span>
                  <time className="trace-row-when" dateTime={did?.last ?? t.occurred_at}>{fmtRelative(did?.last ?? t.occurred_at)}</time>
                </li>
              );
            })}
          </ul>
        )}
      </Async>
    </Panel>
  );
}

/** The most used tools: every stored call when the service can count them, otherwise the latest calls loaded. */
export function ToolsPanel({ aggregates, sample, picked }: {
  aggregates: ReturnType<typeof useToolAggregates>; sample: ReturnType<typeof useToolScan>; picked: Load<ToolStat[]> | null;
}) {
  const { hrefPage } = useUrl();
  // Rows picked as a filter have their own counts, which are shown only once every picked row has loaded.
  const top = useMemo(() => (picked ? dataOf(picked) ?? [] : aggregates.data ?? toolStats(sample.data?.rows ?? [])).slice(0, 6), [picked, aggregates.data, sample.data]);
  const sub = aggregates.data ? 'All matching stored calls' : sample.data ? (sample.data.complete ? `All ${fmtInt(sample.data.scanned)} calls` : `Latest ${fmtInt(sample.data.scanned)} calls`) : 'Loading calls';
  return (
    <Panel title="Most used tools" sub={sub} action={<AppLink className="link" href={hrefPage('Tool Calls')}>Tool Calls</AppLink>}>
      <Async<unknown> query={picked ?? (aggregates.isError ? sample : aggregates)} skeleton={<SkeletonRows label="Loading tools" />} isEmpty={() => !top.length} compact>
        {() => (
          <RankedBars
            label="Tool calls by tool"
            items={top.map((t) => ({
              key: t.name, label: <ToolName name={t.name} />, value: t.calls,
              href: hrefPage('Tool Calls', { tool: t.name }),
              display: (
                <>
                  {t.failed > 0 && <span className="ranked-failed" title={`${fmtInt(t.failed)} failed`}><XCircle size={12} aria-hidden="true" />{fmtPct(t.failed / t.calls, 1)}<span className="sr-only"> failed</span></span>}
                  {fmtCompact(t.calls)}
                </>
              ),
            }))}
          />
        )}
      </Async>
    </Panel>
  );
}

/** Delegation in the window, by the same definition as Agent Trees, with the three busiest delegating threads one click away. */
export function DelegationPanel({ threads, agents, forest, window, model, picking, activity }: {
  threads: ReturnType<typeof useThreads>; agents: ReturnType<typeof useAgents>; forest: Forest | null; window: Filters; model: string | undefined;
  picking: boolean; activity: Map<string, ThreadActivity>;
}) {
  const { hrefPage } = useUrl();
  const delegation = useMemo(() => {
    if (!forest) return null;
    // A tree in view that started at least one sub-agent inside the window.
    const inView = forestInView(forest.roots, { since: window.since, until: window.until, model }).trees
      .filter((r) => !picking || (!!r.thread && activity.has(r.thread.source_id)));
    const scored = inView.map((r) => ({ root: r, s: treeStats(r, window) })).filter((x) => x.s.delegated > 0);
    const stats = scored.map((x) => x.s);
    return {
      top: [...scored].sort((a, b) => b.s.delegated - a.s.delegated || b.s.busyMs - a.s.busyMs).slice(0, 3).map((x) => ({ key: x.root.key, title: x.root.title, delegated: x.s.delegated, busy: x.s.busyMs })),
      trees: stats.length,
      deepest: Math.max(0, ...stats.map((s) => s.maxDepth)),
      fanout: Math.max(0, ...stats.map((s) => s.maxFanout)),
      parallel: Math.max(0, ...stats.map((s) => s.peakParallel)),
      busy: stats.reduce((sum, s) => sum + s.busyMs, 0),
      returned: stats.reduce((sum, s) => sum + s.returned, 0),
      known: stats.reduce((sum, s) => sum + s.returned + s.notReturned, 0),
    };
  }, [forest, model, window, picking, activity]);
  return (
    <Panel title="Delegation" sub={threads.data?.complete === false || agents.data?.complete === false ? 'Latest records only, so these are lower bounds' : 'From recorded parent links only'} action={<AppLink className="link" href={hrefPage('Agent Trees')}>Agent Trees</AppLink>}>
      {threads.error ?? agents.error ? <ErrorState error={threads.error ?? agents.error} onRetry={() => { threads.refetch(); agents.refetch(); }} compact />
        : !delegation ? <SkeletonRows rows={5} label="Loading delegation" />
          : !delegation.trees ? <EmptyState title="No delegation recorded here" compact><p>No thread in this view has a recorded sub-agent.</p></EmptyState>
            : (
              <>
                <dl className="facts">
                  <div><dt>Delegating threads</dt><dd>{fmtInt(delegation.trees)}</dd></div>
                  <div><dt>Deepest level</dt><dd>{fmtInt(delegation.deepest)}</dd></div>
                  <div><dt>Largest fan-out</dt><dd>{fmtInt(delegation.fanout)}</dd></div>
                  <div><dt>Peak parallel</dt><dd>{fmtInt(delegation.parallel)}</dd></div>
                  <div><dt>Sub-agent busy time</dt><dd>{fmtDuration(delegation.busy)}</dd></div>
                  <div><dt>Results delivered</dt><dd>{delegation.known ? `${fmtInt(delegation.returned)} of ${fmtInt(delegation.known)} recorded` : <Unknown />}</dd></div>
                </dl>
                <ol className="busiest-trees" aria-label="Busiest delegating threads">
                  {delegation.top.map((t) => (
                    <li key={t.key}>
                      <AppLink className="row-link" href={hrefPage('Agent Trees', { root: t.key, node: null })}><span>{t.title}</span></AppLink>
                      <small>{plural(t.delegated, 'sub-agent')}{t.busy > 0 ? ` · ${fmtDuration(t.busy)} busy` : ''}</small>
                    </li>
                  ))}
                </ol>
              </>
            )}
    </Panel>
  );
}
