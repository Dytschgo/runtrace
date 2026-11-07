import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ModelName } from '../components/model';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, CornerDownRight, GitBranch, History, Network, Play } from 'lucide-react';
import { DataTable, type Column } from '../components/DataTable';
import { AppLink, Async, DisclosurePanel, EmptyState, ErrorState, Tokens, NoRecords, PageHeader, Panel, plural, QualityBadge, ScanNote, Segmented, SkeletonRows, Stat, StatRow, StatusBadge, Tag, Unknown, NotYetPage } from '../components/ui';
import { getJson } from '../lib/api';
import { useAgents, useFilters, useLiveTurns, useProjects, useThreads, useThreadTokens } from '../lib/data';
import { windowTokens } from '../lib/analytics';
import { contentField, parseContent, toRun, toTurn, type ThreadRow } from '../lib/entities';
import { inTimeRange, isFuture } from '../lib/filters';
import { fmtClock, fmtCompact, fmtDateTime, fmtDay, fmtDuration, fmtInt, fmtRelative, fmtShortDateTime, isKnown, cleanText, repairText } from '../lib/format';
import { useSettings } from '../lib/settings';
import { durationMs } from '../lib/entities';
import type { Entity, Envelope } from '../lib/types';
import { useUrl } from '../lib/url';

const TOKEN_WHY = 'No complete provider-turn total is recorded for this.';

/** The played-back story of a thread lives at ?page=Threads&id=…&story=1, so it can be linked like any other view. */
const AgentStory = lazy(() => import('./AgentStory'));

export default function Threads() {
  const { params } = useUrl();
  const id = params.get('id');
  if (id && params.get('story')) return <Suspense fallback={<SkeletonRows rows={6} label="Loading the story" />}><AgentStory id={id} /></Suspense>;
  return id ? <ThreadDetail id={id} /> : <ThreadList />;
}

type Row = ThreadRow & { kids: number; tokenTotal: number | null; turns: number; short: boolean };

function ThreadList() {
  const { params, set, hrefPage } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const threads = useThreads(f);
  const agents = useAgents(f);
  const projects = useProjects();
  // The same turns the Overview reads, cut to the same window, so both pages add up the same tokens.
  const live = useLiveTurns(f);
  const windowStart = f.since ? Date.parse(f.since) : -Infinity;
  const turnsReady = windowStart >= live.coversFrom ? !!(live.recent.data || live.all.data) : !!live.all.data;
  const win = useMemo(() => windowTokens(live.rows, f), [live.rows, f]);
  const type = params.get('type') ?? 'all';
  const tq = params.get('tq') ?? '';
  const [draft, setDraft] = useState(tq);
  useEffect(() => setDraft(tq), [tq]);
  useEffect(() => {
    if (draft === tq) return;
    const t = window.setTimeout(() => set({ tq: draft, offset: null }, { replace: true }), 180);
    return () => window.clearTimeout(t);
  }, [draft, tq, set]);

  const kids = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents.data?.rows ?? []) m.set(a.thread_id, (m.get(a.thread_id) ?? 0) + 1);
    return m;
  }, [agents.data]);

  // A thread is in view when it started in the window or used tokens in it, so long threads are not cut out of the total.
  const inScope = useMemo<Row[]>(() => (threads.data?.rows ?? [])
    .filter((t) => (inTimeRange(t.occurred_at, f) || win.byThread.has(t.source_id)) && (!f.model || t.model === f.model || win.byThread.has(t.source_id)))
    .map((t) => { const u = win.byThread.get(t.source_id); return { ...t, kids: kids.get(t.source_id) ?? 0, tokenTotal: u?.total ?? null, turns: u?.turns ?? 0, short: !!u && (u.withTotal ?? u.withUsage) < u.turns }; }), [threads.data, f, kids, win]);
  const startedHere = inScope.filter((t) => inTimeRange(t.occurred_at, f)).length;
  const rows = useMemo(() => {
    const needle = tq.trim().toLowerCase();
    return inScope.filter((t) => (type === 'all' || t.type === type) && (!needle || t.title.toLowerCase().includes(needle) || (t.branch ?? '').toLowerCase().includes(needle)));
  }, [inScope, type, tq]);

  const primary = inScope.filter((t) => t.type === 'primary').length;
  const child = inScope.filter((t) => t.type === 'child').length;
  const deepest = inScope.reduce((d, t) => Math.max(d, t.depth ?? 0), 0);
  const atLeast = win.total !== null && win.reported < win.turns;
  const outsideThreads = [win.logTotal ? `${fmtCompact(win.logTotal)} from session logs` : '', win.unthreaded ? `${fmtCompact(win.unthreaded)} with no thread` : ''].filter(Boolean).join(' · ');
  const manyProjects = (projects.data?.length ?? 0) > 1;
  const projectName = (id: string) => { const p = projects.data?.find((r) => r.source_id === id); return p ? repairText(String(p.data?.name ?? id)) : id; };

  const columns: Column<Row>[] = [
    {
      key: 'title', header: 'Thread', sort: (t) => t.title, className: 'cell-title',
      render: (t) => (
        <AppLink className="row-link" href={hrefPage('Threads', { id: t.source_id })}>
          {t.type === 'child' && <CornerDownRight size={13} aria-hidden="true" className="row-link-lead" />}
          <span>{t.title}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </AppLink>
      ),
    },
    {
      key: 'tokens', header: 'Tokens', align: 'end', className: 'cell-tokens', sort: (t) => t.tokenTotal,
      render: (t) => (!turnsReady ? <span className="fine" aria-label="Loading">…</span> : t.tokenTotal === null && !t.turns ? <span className="fine">None here</span> : <>{t.short && !!t.tokenTotal && <span className="lower-bound" title="Some turns in this thread reported no total"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}<Tokens v={t.tokenTotal} why={TOKEN_WHY} /></>),
    },
    { key: 'story', header: 'Play', render: (t) => <AppLink className="icon-btn" href={hrefPage('Threads', { id: t.source_id, story: '1' })} ariaLabel={`Play the story of ${t.title}`} title="Play the story"><Play size={14} aria-hidden="true" /></AppLink> },
    { key: 'type', header: 'Type', sort: (t) => t.type, render: (t) => <span className={`type type-${t.type}`}>{t.type === 'child' ? `Child · depth ${t.depth ?? '?'}` : t.type === 'primary' ? 'Primary' : 'Unknown'}</span> },
    { key: 'model', header: 'Model', sort: (t) => t.model, render: (t) => (t.model ? <ModelName model={t.model} /> : <Unknown label="Unknown" why="The thread has no recorded model selection." />) },
    { key: 'kids', header: 'Sub-agents', align: 'end', sort: (t) => t.kids, render: (t) => (t.kids ? fmtInt(t.kids) : <span className="fine">None</span>) },
    { key: 'branch', header: 'Branch', sort: (t) => t.branch, render: (t) => (t.branch ? <span className="mono cell-clip" title={t.branch}>{t.branch}</span> : <span className="fine">None recorded</span>) },
    ...(manyProjects ? [{ key: 'project', header: 'Project', sort: (t: Row) => projectName(t.project_id), render: (t: Row) => projectName(t.project_id) }] : []),
    { key: 'started', header: 'Started', sort: (t) => t.occurred_at, render: (t) => <time dateTime={t.occurred_at}>{fmtShortDateTime(t.occurred_at, timezone)}</time> },
    { key: 'updated', header: 'Last update', sort: (t) => t.updated_at, render: (t) => (t.updated_at ? <span title={fmtDateTime(t.updated_at, timezone)}>{fmtRelative(t.updated_at)}</span> : <span className="fine">Unknown</span>) },
    { key: 'quality', header: 'Capture', sort: (t) => t.quality, render: (t) => <QualityBadge quality={t.quality} /> },
  ];

  if (isFuture(f)) return <NotYetPage title="Threads" />;

  return (
    <>
      <PageHeader title="Threads" lead="Open one to read it." />
      <StatRow label="Thread summary">
        <Stat label="In view" value={threads.isPending || !turnsReady ? '…' : fmtInt(inScope.length)} sub={threads.data ? <>{startedHere < inScope.length && <>{fmtInt(startedHere)} started here · </>}<ScanNote scanned={threads.data.scanned} complete={threads.data.complete} noun="threads" /></> : undefined} />
        <Stat label="Primary" value={threads.isPending ? '…' : fmtInt(primary)} sub="Started directly" />
        <Stat label="Child" value={threads.isPending ? '…' : fmtInt(child)} sub={`Deepest level ${fmtInt(deepest)}`} />
        <Stat
          label="Tokens"
          value={!turnsReady ? <span role="status" aria-label="Loading tokens">…</span> : win.total === null ? <Unknown why={TOKEN_WHY} /> : <>{atLeast && <span className="lower-bound" title="Some turns reported no total"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}<Tokens v={win.total} /></>}
          sub={!turnsReady ? 'Reading turns' : outsideThreads ? `Used in this window · ${outsideThreads}` : 'Used in this window'}
        />
      </StatRow>
      <Panel
        title="All threads"
        action={
          <div className="toolbar">
            <label className="field field-search">
              <span className="sr-only">Filter threads by title or branch</span>
              <input type="search" placeholder="Filter by title or branch" value={draft} onChange={(e) => setDraft(e.target.value)} />
            </label>
            <Segmented label="Thread type" value={type} onChange={(v) => set({ type: v === 'all' ? null : v, offset: null }, { replace: true })}
              options={[{ value: 'all', label: 'All' }, { value: 'primary', label: 'Primary' }, { value: 'child', label: 'Child' }]} />
          </div>
        }
        flush
      >
        <Async query={threads} skeleton={<div className="pad"><SkeletonRows rows={10} label="Loading threads" /></div>}>
          {() => (
            <DataTable
              rows={rows} columns={columns} rowKey={(t) => t.id} caption="Threads" defaultSort={{ key: 'started', dir: 'desc' }} exportName="runtrace-threads"
              empty={<NoRecords />}
            />
          )}
        </Async>
      </Panel>
    </>
  );
}

const PAGE = 100;
const VIEWS = { conversation: ['prompt', 'answer', 'agent'], tools: ['tool'], all: ['prompt', 'answer', 'agent', 'tool', 'run', 'model_turn', 'external_request'] } as const;

function ThreadDetail({ id }: { id: string }) {
  const { params, set, hrefPage, hrefPatch } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const threads = useThreads({ instance: f.instance });
  const agents = useAgents({ instance: f.instance });
  const tokens = useThreadTokens({ instance: f.instance });
  const threadUsage = tokens.get(id);
  const view = (params.get('view') ?? 'conversation') as keyof typeof VIEWS;

  const timeline = useInfiniteQuery({
    queryKey: ['thread-timeline', id],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => (await getJson<Envelope<Entity>>('timeline', new URLSearchParams({ id, limit: String(PAGE), offset: String(pageParam) }), signal)).data ?? [],
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length * PAGE : undefined),
  });

  const thread = threads.data?.rows.find((t) => t.source_id === id) ?? null;
  const events = useMemo(() => (timeline.data?.pages.flat() ?? []).filter((e) => e.kind !== 'thread').slice().reverse(), [timeline.data]);
  const shown = useMemo(() => events.filter((e) => (VIEWS[view] as readonly string[]).includes(e.kind)), [events, view]);
  const runs = useMemo(() => events.filter((e) => e.kind === 'run').map(toRun), [events]);
  const turns = useMemo(() => events.filter((e) => e.kind === 'model_turn').map(toTurn), [events]);
  const children = useMemo(() => (agents.data?.rows ?? []).filter((a) => a.thread_id === id), [agents.data, id]);
  const byKind = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [events]);
  const parent = thread?.parent ? threads.data?.rows.find((t) => t.source_id === thread.parent) ?? null : null;
  const more = timeline.hasNextPage;
  // Busy threads end in a run of tool calls, so a filtered view reads further back until it has something to show.
  const loadedPages = timeline.data?.pages.length ?? 0;
  const { fetchNextPage, isFetchingNextPage } = timeline;
  useEffect(() => {
    if (timeline.isSuccess && !shown.length && more && !isFetchingNextPage && loadedPages < 10) fetchNextPage();
  }, [timeline.isSuccess, shown.length, more, isFetchingNextPage, loadedPages, fetchNextPage]);
  const qualifier = more ? ' in the loaded part' : '';

  return (
    <>
      <AppLink className="back" href={hrefPage('Threads')}><ArrowLeft size={14} aria-hidden="true" /> Threads</AppLink>
      <PageHeader
        title={thread?.title ?? (threads.isPending ? 'Loading thread' : 'Thread')}
        lead={thread ? <>{thread.type === 'child' ? `Delegated thread, depth ${thread.depth ?? '?'}` : thread.type === 'primary' ? 'Primary thread' : 'Thread type unknown'}. Started {fmtDateTime(thread.occurred_at, timezone)}.</> : undefined}
        action={
          <>
            <AppLink className="btn" href={hrefPatch({ story: '1' })}><Play size={14} aria-hidden="true" /> Play the story</AppLink>
            {thread && (thread.root || children.length > 0) && <AppLink className="btn" href={hrefPage('Agent Trees', { root: thread.root ?? id, node: id })}><Network size={14} aria-hidden="true" /> View in tree</AppLink>}
          </>
        }
      />

      {threads.isSuccess && !thread && (
        <Panel><EmptyState compact title="This thread is not in the imported list"><p>It may have been purged or belong to another instance. Any records stored against it are shown below.</p></EmptyState></Panel>
      )}

      {thread && (
        <section className="panel facts-panel" aria-label="Thread facts">
          <dl className="facts facts-grid">
            <div><dt>Model</dt><dd>{thread.model ? <ModelName model={thread.model} /> : <Unknown label="Unknown" />}</dd></div>
            <div><dt>Resolved model</dt><dd><Unknown why="Only the requested model is recorded." /></dd></div>
            <div><dt>Complete-turn tokens</dt><dd>{threadUsage && !!threadUsage.total && (threadUsage.withTotal ?? threadUsage.withUsage) < threadUsage.turns && <span className="lower-bound" title="Some turns reported no total"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}<Tokens v={threadUsage?.total ?? thread.tokens} why={TOKEN_WHY} />{threadUsage && threadUsage.withUsage < threadUsage.turns && <small className="fine"> {fmtInt(threadUsage.withUsage)} of {fmtInt(threadUsage.turns)} turns reported</small>}</dd></div>
            <div><dt>Branch</dt><dd>{thread.branch ? <span className="mono cell-clip"><GitBranch size={12} aria-hidden="true" /> {thread.branch}</span> : <span className="fine">None recorded</span>}</dd></div>
            <div><dt>Last update</dt><dd title={thread.updated_at ?? undefined}>{thread.updated_at ? fmtShortDateTime(thread.updated_at, timezone) : <Unknown label="Unknown" />}</dd></div>
            <div><dt>Parent</dt><dd>{thread.parent ? (parent ? <AppLink className="link" href={hrefPage('Threads', { id: parent.source_id })}>{parent.title}</AppLink> : <span className="fine">Not imported</span>) : <span className="fine">None</span>}</dd></div>
            <div><dt>Tool capture</dt><dd><QualityBadge quality={thread.toolCoverage ?? 'unavailable'} /></dd></div>
            <div><dt>Archived</dt><dd>{thread.archived ? fmtShortDateTime(thread.archived, timezone) : <span className="fine">No</span>}</dd></div>
          </dl>
        </section>
      )}

      {children.length > 0 && (
        <DisclosurePanel title="Sub-agents" sub={`${plural(children.length, 'sub-agent')} recorded by this thread`}>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Sub-agents">
            <table className="sticky-first">
              <thead><tr><th scope="col">Thread</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col" className="num">Time</th><th scope="col">Result delivered</th></tr></thead>
              <tbody>
                {children.slice(0, 100).map((a) => {
                  const t = threads.data?.rows.find((x) => x.source_id === a.child);
                  return (
                    <tr key={a.id}>
                      <td className="cell-title">{a.child ? <AppLink className="row-link" href={hrefPage('Threads', { id: a.child })}><span>{t?.title ?? a.task?.split('\n')[0].slice(0, 90) ?? 'Child thread'}</span><ChevronRight size={14} aria-hidden="true" /></AppLink> : a.task?.slice(0, 90) ?? 'Provider-native sub-agent'}</td>
                      <td>{a.model ? <ModelName model={a.model} /> : <Unknown label="Unknown" />}</td>
                      <td><StatusBadge status={a.status} /></td>
                      <td className="num">{a.duration === null ? <Unknown label="Unknown" why="No completion time recorded." /> : fmtDuration(a.duration)}</td>
                      <td>{a.returned === null ? <Unknown label="Not recorded" why="No explicit delivery record. This does not mean the result was lost." /> : a.returned ? <Tag>Acknowledged</Tag> : <Tag tone="warn">Not acknowledged</Tag>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {children.length > 100 && <p className="fine pad">Showing the first 100. The tree view shows all of them.</p>}
        </DisclosurePanel>
      )}

      {turns.length > 0 && (
        <DisclosurePanel title="Provider turns" sub={`${plural(turns.length, 'turn')}${qualifier}, oldest first. A turn can contain several model calls.`}>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Provider turns">
            <table className="sticky-first">
              <thead><tr><th scope="col">Started</th><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Status</th><th scope="col" className="num">Latency</th><th scope="col" className="num">Input</th><th scope="col" className="num">Cached</th><th scope="col" className="num">Output</th><th scope="col" className="num">Reasoning</th><th scope="col" className="num">Total</th><th scope="col">Usage</th></tr></thead>
              <tbody>
                {turns.map((t) => (
                  <tr key={t.id}>
                    <td><time dateTime={t.occurred_at}>{fmtShortDateTime(t.occurred_at, timezone)}</time></td>
                    <td>{t.model ? <span className="mono">{t.model}</span> : <span className="fine">Not recorded</span>}</td>
                    <td>{t.provider ?? <span className="fine">Not recorded</span>}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="num">{t.duration === null ? <span className="fine">Unknown</span> : fmtDuration(t.duration)}</td>
                    <td className="num"><Tokens v={t.input} /></td>
                    <td className="num"><Tokens v={t.cached} /></td>
                    <td className="num"><Tokens v={t.output} /></td>
                    <td className="num"><Tokens v={t.reasoning} /></td>
                    <td className="num"><Tokens v={t.total} /></td>
                    <td><QualityBadge quality={t.usage} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DisclosurePanel>
      )}

      {runs.length > 0 && (
        <DisclosurePanel title="Runs" sub={`${plural(runs.length, 'turn')}${qualifier}, oldest first`}>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Runs">
            <table className="sticky-first">
              <thead><tr><th scope="col">Started</th><th scope="col">Requested model</th><th scope="col">Provider</th><th scope="col">Status</th><th scope="col" className="num">Time</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.source_id}>
                    <td><time dateTime={r.occurred_at}>{fmtShortDateTime(r.occurred_at, timezone)}</time></td>
                    <td>{r.requested ? <span className="mono">{r.requested}</span> : <Unknown label="Unknown" />}</td>
                    <td>{r.provider ?? <span className="fine">Unknown</span>}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="num">{r.duration === null ? <span className="fine">{r.status === 'running' ? 'In progress' : 'Unknown'}</span> : fmtDuration(r.duration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DisclosurePanel>
      )}

      <Panel
        title="Thread timeline"
        sub={`${fmtInt(byKind.prompt ?? 0)} prompts, ${fmtInt(byKind.answer ?? 0)} answers, ${fmtInt(byKind.tool ?? 0)} tool calls${qualifier}`}
        action={
          <Segmented label="Timeline view" value={view} onChange={(v) => set({ view: v === 'conversation' ? null : v }, { replace: true })}
            options={[{ value: 'conversation', label: 'Conversation' }, { value: 'tools', label: 'Tools' }, { value: 'all', label: 'Everything' }]} />
        }
      >
        {timeline.isPending ? <SkeletonRows rows={8} label="Loading timeline" />
          : timeline.isError ? <ErrorState error={timeline.error} onRetry={() => timeline.refetch()} compact />
            : (
              <>
                {more && (
                  <div className="load-earlier">
                    <button type="button" className="btn" disabled={timeline.isFetchingNextPage} onClick={() => timeline.fetchNextPage()}>
                      <History size={14} aria-hidden="true" /> {timeline.isFetchingNextPage ? 'Loading…' : 'Load earlier events'}
                    </button>
                    <span className="fine">Newest {fmtInt(timeline.data.pages.length * PAGE)} events loaded.</span>
                  </div>
                )}
                {shown.length ? (
                  <ol className="timeline">{shown.map((e) => <TimelineItem key={e.id} e={e} tz={timezone} detailHref={e.kind === 'agent' && typeof e.data?.child_thread_id === 'string' ? hrefPage('Threads', { id: e.data.child_thread_id }) : undefined} />)}</ol>
                ) : (
                  <EmptyState compact title="Nothing of this kind in the loaded events">
                    <p>{more ? 'Load earlier events, or show everything.' : <>Show <AppLink className="link" href={hrefPatch({ view: 'all' })}>everything</AppLink>. Records that were not captured are not listed.</>}</p>
                  </EmptyState>
                )}
              </>
            )}
      </Panel>
    </>
  );
}

const TEXT_CAP = 2400;

function LongText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > TEXT_CAP;
  return (
    <>
      <div className="message-text">{all || !long ? text : `${text.slice(0, TEXT_CAP)}…`}</div>
      {long && <button type="button" className="link-btn" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? 'Show less' : `Show all ${fmtInt(text.length)} characters`}</button>}
    </>
  );
}

export function ToolContent({ data }: { data: Record<string, unknown> }) {
  const c = parseContent(data);
  if (!c.raw) return <p className="fine">Content withheld by capture policy.</p>;
  const parts = c.fields
    ? ([['Arguments', c.fields.arguments], ['Result', c.fields.result], ['Diff', c.fields.diff]] as const).flatMap(([label, v]) => { const s = contentField(v); return s ? [[label, s] as const] : []; })
    : [['Stored content', cleanText(c.raw)] as const];
  if (!parts.length) return <p className="fine">No arguments or output were recorded.</p>;
  return (
    <>
      {parts.map(([label, s]) => (
        <div key={label} className="tool-part">
          <h3>{label}</h3>
          <pre tabIndex={0}>{s.length > 40_000 ? `${s.slice(0, 40_000)}\n… ${fmtInt(s.length - 40_000)} more characters not shown` : s}</pre>
        </div>
      ))}
    </>
  );
}

function ToolItem({ e, tz }: { e: Entity; tz: string }) {
  const [open, setOpen] = useState(false);
  const d = e.data ?? {};
  const duration = durationMs(d);
  const failed = d.status === 'failed';
  return (
    <details className={failed ? 'tool-item is-failed' : 'tool-item'} onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="mono tool-name">{String(d.tool_name ?? 'tool')}</span>
        {d.status !== 'completed' && <StatusBadge status={typeof d.status === 'string' ? d.status : null} />}
        {isKnown(d.exit_code) && d.exit_code !== 0 && <Tag tone="crit">exit {d.exit_code}</Tag>}
        <span className="tool-side">{duration === null ? '' : fmtDuration(duration)}<time dateTime={e.occurred_at}>{fmtClock(e.occurred_at, tz)}</time></span>
      </summary>
      {open && <ToolContent data={d} />}
    </details>
  );
}

function TimelineItem({ e, tz, detailHref }: { e: Entity; tz: string; detailHref?: string }) {
  const d = e.data ?? {};
  if (e.kind === 'model_turn') {
    const t = toTurn(e);
    return (
      <li className="tl tl-run">
        <div className="tl-head">
          <strong>Provider turn</strong>
          {t.model && <span className="mono">{t.model}</span>}
          <span><Tokens v={t.total} /> tokens</span>
          {t.duration !== null && <span>{fmtDuration(t.duration)}</span>}
          <time dateTime={e.occurred_at}>{fmtDay(e.occurred_at, tz)} {fmtClock(e.occurred_at, tz)}</time>
        </div>
      </li>
    );
  }
  if (e.kind === 'external_request') {
    return <li className="tl tl-run"><div className="tl-head"><strong>External request</strong><time dateTime={e.occurred_at}>{fmtDay(e.occurred_at, tz)} {fmtClock(e.occurred_at, tz)}</time></div></li>;
  }
  if (e.kind === 'tool') return <li className="tl tl-tool"><ToolItem e={e} tz={tz} /></li>;
  if (e.kind === 'run') {
    const r = toRun(e);
    return (
      <li className="tl tl-run">
        <div className="tl-head"><strong>Run</strong><span className="mono">{r.requested ?? 'Model unknown'}</span><StatusBadge status={r.status} /><time dateTime={e.occurred_at}>{fmtDay(e.occurred_at, tz)} {fmtClock(e.occurred_at, tz)}</time></div>
      </li>
    );
  }
  if (e.kind === 'agent') {
    const c = parseContent(d);
    const task = contentField(c.fields?.task);
    const result = contentField(c.fields?.result);
    return (
      <li className="tl tl-agent">
        <div className="tl-head">
          <strong>Delegated to sub-agent</strong>
          {typeof d.model === 'string' && <span className="mono">{d.model}</span>}
          <StatusBadge status={typeof d.status === 'string' ? d.status : null} />
          <time dateTime={e.occurred_at}>{fmtDay(e.occurred_at, tz)} {fmtClock(e.occurred_at, tz)}</time>
        </div>
        {task && <details className="agent-part"><summary>Task</summary><LongText text={task} /></details>}
        {result && <details className="agent-part"><summary>Result</summary><LongText text={result} /></details>}
        {detailHref && <AppLink className="link" href={detailHref}>Open child thread</AppLink>}
      </li>
    );
  }
  const isPrompt = e.kind === 'prompt';
  const text = typeof d.content_redacted === 'string' ? cleanText(d.content_redacted) : null;
  return (
    <li className={isPrompt ? 'tl tl-prompt' : 'tl tl-answer'}>
      <div className="tl-head">
        <strong>{isPrompt ? 'User prompt' : 'Agent answer'}</strong>
        {typeof d.model === 'string' && !isPrompt && <span className="mono">{d.model}</span>}
        {isKnown(d.redaction_count) && d.redaction_count > 0 && <Tag>{fmtInt(d.redaction_count)} redacted</Tag>}
        <time dateTime={e.occurred_at}>{fmtDay(e.occurred_at, tz)} {fmtClock(e.occurred_at, tz)}</time>
      </div>
      {text ? <LongText text={text} /> : <p className="fine">Content withheld by capture policy.</p>}
    </li>
  );
}
