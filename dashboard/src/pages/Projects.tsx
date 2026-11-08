import { hasTurnUsage } from '../lib/entities';
import { ModelName } from '../components/model';
import { useMemo } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { ActivityChart } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';
import { TokenFacts } from '../components/tokens';
import { AppLink, Async, ChartPanel, EmptyState, NoRecords, PageHeader, Panel, plural, RankedBars, Skeleton, SkeletonRows, Stat, StatRow, Tag, Tokens, Unknown, NotYetPage } from '../components/ui';
import { bucketActivity, tokensByKey, tokenSummary } from '../lib/analytics';
import { useAgents, useFilters, useHourly, useModels, useModelTurns, useOverview, useOverviews, useProjects, useThreads, useUsage } from '../lib/data';
import type { Filters } from '../lib/filters';
import { inTimeRange, isFuture } from '../lib/filters';
import { fmtCompact, fmtDateTime, fmtInt, fmtRelative, fmtShortDateTime, repairText } from '../lib/format';
import { projectColor } from '../lib/series';
import { useSettings } from '../lib/settings';
import { useUrl } from '../lib/url';

const PER_PROJECT = 24;

interface Row {
  id: string; name: string; alias: string | null; created: string;
  threads: number | null; prompts: number | null; runs: number | null; turns: number | null; tools: number | null; agents: number | null;
  tokens: number | null; share: number;
  /** Some provider turns here reported no total, so the tokens are at least this much. */
  atLeast: boolean;
}

export default function Projects() {
  const { hrefPage, hrefPatch } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const base: Filters = { ...f, model: undefined };
  const projects = useProjects();
  const usage = useUsage('projects', base);
  const turns = useModelTurns({ ...base, project: undefined }, usage.isError);
  const list = useMemo(() => (projects.data ?? []).filter((p) => !f.instance || p.instance_id === f.instance), [projects.data, f.instance]);
  // Per-project counts come from one aggregate when available. Thread counts and an older service use the per-project overview.
  const needsFallback = usage.isError || (usage.data !== undefined && usage.data.some((u) => u.observed_threads === undefined));
  const stats = useOverviews(list.slice(0, PER_PROJECT).map((p) => ({ ...base, project: p.source_id })), needsFallback);
  const tokenFallback = useMemo(() => tokensByKey(turns.data?.rows ?? [], (t) => t.project_id, (t) => t.total, hasTurnUsage), [turns.data]);

  const rows: Row[] = useMemo(() => {
    const byId = new Map((usage.data ?? []).map((u) => [u.identity, u]));
    const raw = list.map((p, i) => {
      const u = byId.get(p.source_id);
      const c = i < PER_PROJECT ? stats[i]?.data : undefined;
      // With the aggregate in hand, a project it does not list had no records in the window, which is a true zero.
      const usageReady = usage.data !== undefined && !needsFallback;
      const pick = (fromUsage: number | undefined, kind: string) => fromUsage ?? (usageReady ? 0 : c ? c[kind] ?? 0 : null);
      const alias = p.data?.git_remote_alias ?? p.data?.repository_root_alias;
      return {
        id: p.source_id, name: repairText(String(p.data?.name ?? p.source_id)), alias: typeof alias === 'string' ? alias : null, created: p.occurred_at,
        threads: pick(u?.observed_threads, 'thread'), prompts: pick(u?.observed_prompts, 'prompt'), runs: pick(u?.observed_runs, 'run'), turns: pick(u?.observed_provider_turns, 'model_turn'),
        tools: pick(u?.observed_tool_calls, 'tool'), agents: pick(u?.observed_agents, 'agent'),
        tokens: u ? u.total_tokens : tokenFallback.get(p.source_id)?.total ?? null, share: 0,
        atLeast: !!u && u.total_tokens !== null && u.reported_turns !== undefined && u.reported_turns < u.observed_provider_turns,
      };
    });
    const max = Math.max(1, ...raw.map((r) => r.tokens ?? 0));
    return raw.map((r) => ({ ...r, share: (r.tokens ?? 0) / max }));
  }, [list, usage.data, stats, tokenFallback, needsFallback]);

  const loading = usage.isPending || (needsFallback && stats.some((q) => q.isPending));
  const num = (v: number | null) => (v !== null ? fmtInt(v) : loading ? <span className="fine" role="status" aria-label="Loading">…</span> : <Unknown label="Not counted" why={`Only the first ${PER_PROJECT} projects are counted one by one when the service has no project totals.`} />);
  const hasTokens = loading || rows.some((r) => r.tokens !== null);
  const columns: Column<Row>[] = [
    {
      key: 'name', header: 'Project', sort: (r) => r.name, className: 'cell-title',
      render: (r) => (
        <>
          {/* The same colour the project has on the Overview chart, which comes from its id alone. */}
          <AppLink className="row-link" href={hrefPage('Threads', { project: r.id })} title="Open this project's threads"><Folder className="project-swatch" size={14} aria-hidden="true" style={{ color: projectColor(r.id) }} />{r.name}<ChevronRight size={14} aria-hidden="true" /></AppLink>
          {r.alias && r.alias !== r.name && <span className="project-sub mono">{r.alias}</span>}
        </>
      ),
    },
    ...(hasTokens ? [{
      key: 'tokens', header: 'Tokens', align: 'end' as const, sort: (r: Row) => r.tokens,
      render: (r: Row) => (
        <span className="token-cell">
          <span className="bar-cell-track" aria-hidden="true"><span style={{ inlineSize: `${r.share * 100}%` }} /></span>
          {loading && r.tokens === null ? <span className="fine" role="status" aria-label="Loading">…</span> : r.tokens === null && r.turns === 0 ? <span className="fine">None</span> : <>{r.atLeast && <span className="lower-bound" title="Some turns reported no total"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}<Tokens v={r.tokens} /></>}
        </span>
      ),
    }] : []),
    { key: 'threads', header: 'Threads', align: 'end', sort: (r) => r.threads, render: (r) => num(r.threads) },
    { key: 'prompts', header: 'Prompts', align: 'end', sort: (r) => r.prompts, render: (r) => num(r.prompts) },
    { key: 'runs', header: 'Runs', align: 'end', sort: (r) => r.runs, render: (r) => num(r.runs) },
    { key: 'turns', header: 'Provider turns', align: 'end', sort: (r) => r.turns, render: (r) => num(r.turns) },
    { key: 'tools', header: 'Tool calls', align: 'end', sort: (r) => r.tools, render: (r) => num(r.tools) },
    { key: 'agents', header: 'Sub-agents', align: 'end', sort: (r) => r.agents, render: (r) => num(r.agents) },
    { key: 'created', header: 'First seen', sort: (r) => r.created, render: (r) => <time dateTime={r.created}>{fmtDateTime(r.created, timezone)}</time> },
    { key: 'detail', header: 'Detail', render: (r) => <AppLink className="link" href={hrefPatch({ project: f.project === r.id ? null : r.id })} ariaCurrent={f.project === r.id ? 'true' : undefined} ariaLabel={`${f.project === r.id ? 'Close details for' : 'Show details for'} ${r.name}`}>{f.project === r.id ? 'Close' : 'Show'}</AppLink> },
  ];

  const focusId = f.project ?? (list.length === 1 ? list[0].source_id : undefined);
  const focus = list.find((p) => p.source_id === focusId);

  if (isFuture(f)) return <NotYetPage title="Projects" />;

  return (
    <>
      <PageHeader title="Projects" lead="Where the work went." />
      {focus && <ProjectDetail projectId={focus.source_id} name={repairText(String(focus.data?.name ?? focus.source_id))} base={base} />}
      {f.project && projects.data && !focus && (
        // A project id from an old link or a typo matches nothing, which is said instead of looking like an ordinary full list.
        <Panel>
          <EmptyState title="No such project" compact>
            <p>No imported project has the id <code>{f.project}</code>. Every project is listed below. <AppLink className="link" href={hrefPatch({ project: null })}>Clear the project filter</AppLink></p>
          </EmptyState>
        </Panel>
      )}
      <Panel title="All projects" sub="Identified by T3 project id. Names come from the source and are redacted." flush>
        <Async query={projects} skeleton={<div className="pad"><SkeletonRows label="Loading projects" /></div>} isEmpty={() => !list.length} empty={<NoRecords />}>
          {() => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption="Projects" defaultSort={hasTokens ? { key: 'tokens', dir: 'desc' } : { key: 'prompts', dir: 'desc' }} exportName="runtrace-projects" />}
        </Async>
      </Panel>
    </>
  );
}

function ProjectDetail({ projectId, name, base }: { projectId: string; name: string; base: Filters }) {
  const { hrefPage } = useUrl();
  const { timezone } = useSettings();
  const f: Filters = { ...base, project: projectId };
  const totals = useOverview(f);
  const hourly = useHourly(f);
  const models = useModels(f);
  const threads = useThreads(f);
  const agents = useAgents(f);

  const series = useMemo(() => bucketActivity(hourly.data ?? [], timezone), [hourly.data, timezone]);
  const inWindow = useMemo(() => (threads.data?.rows ?? []).filter((t) => inTimeRange(t.occurred_at, { since: f.since, until: f.until })), [threads.data, f.since, f.until]);
  const branches = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of inWindow) { const b = t.branch ?? 'No branch recorded'; m.set(b, (m.get(b) ?? 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [inWindow]);
  const primaries = useMemo(() => inWindow.filter((t) => t.type !== 'child'), [inWindow]);
  const kidCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents.data?.rows ?? []) m.set(a.thread_id, (m.get(a.thread_id) ?? 0) + 1);
    return m;
  }, [agents.data]);
  const c = totals.data ?? {};
  const summary = useMemo(() => tokenSummary(models.data ?? []), [models.data]);
  const hasTokens = summary.total !== null;
  const last = inWindow[0]?.occurred_at;

  return (
    <>
      <h2 className="section-title">{name}</h2>
      <StatRow label={`${name} summary`}>
        <Stat label="Threads" value={threads.isPending ? '…' : fmtInt(inWindow.length)} sub={`${fmtInt(primaries.length)} primary · ${fmtInt(inWindow.length - primaries.length)} delegated`} />
        <Stat label="Prompts" value={fmtInt(c.prompt ?? 0)} sub={`${fmtInt(c.answer ?? 0)} answers`} />
        <Stat label="Tool calls" value={fmtInt(c.tool ?? 0)} sub={c.prompt ? `${((c.tool ?? 0) / c.prompt).toFixed(1)} per prompt` : undefined} />
        <Stat label="Latest thread" value={last ? fmtRelative(last) : '—'} sub={last ? fmtShortDateTime(last, timezone) : undefined} />
      </StatRow>
      <div className="split">
        <ChartPanel
          className="grow-2"
          title="Prompt activity"
          sub={series.unit === 'hour' ? 'Prompts per hour' : 'Prompts per day'}
          chart={<Async query={hourly} skeleton={<Skeleton height="220px" label="Loading activity" />} isEmpty={(d) => !d.length} compact>{() => <ActivityChart series={series} tz={timezone} height={220} />}</Async>}
          table={<table><thead><tr><th scope="col">Time</th><th scope="col" className="num">Prompts</th></tr></thead><tbody>{series.points.map((p) => <tr key={p.key}><td>{fmtShortDateTime(p.iso, timezone)}</td><td className="num">{fmtInt(p.value)}</td></tr>)}</tbody></table>}
        />
        <Panel className="grow-1" title="Token usage" sub="This project">
          <Async query={models} skeleton={<SkeletonRows label="Loading token usage" />} compact>{() => <TokenFacts s={summary} />}</Async>
        </Panel>
      </div>
      <div className="grid-3">
        <Panel title="Primary threads" sub="Newest first" action={<AppLink className="link" href={hrefPage('Threads', { project: projectId })}>All threads</AppLink>}>
          <Async query={threads} skeleton={<SkeletonRows label="Loading threads" />} isEmpty={() => !primaries.length} compact>
            {() => (
              <ul className="list">
                {primaries.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    <AppLink className="list-title" href={hrefPage('Threads', { id: t.source_id, project: projectId })}>{t.title}</AppLink>
                    <div className="list-meta">
                      <span>{fmtShortDateTime(t.occurred_at, timezone)}</span>
                      {t.branch && <span className="mono">{t.branch}</span>}
                      {(kidCount.get(t.source_id) ?? 0) > 0 && <Tag>{plural(kidCount.get(t.source_id)!, 'sub-agent')}</Tag>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Panel>
        <Panel title="Models" sub={hasTokens ? 'By complete-turn tokens' : 'By observed runs'}>
          <Async query={models} skeleton={<SkeletonRows label="Loading models" />} isEmpty={(d) => !d.length} compact>
            {(rows) => (
              <RankedBars
                label="Models in this project" limit={5}
                items={[...rows].sort((a, b) => (hasTokens ? (b.total_tokens ?? -1) - (a.total_tokens ?? -1) : b.observed_runs - a.observed_runs)).map((m) => ({
                  key: m.model ?? 'not-recorded', label: m.model ? <ModelName model={m.model} /> : <span className="mono">Model not recorded</span>,
                  value: hasTokens ? m.total_tokens ?? 0 : m.observed_runs,
                  display: hasTokens ? <Tokens v={m.total_tokens} /> : fmtCompact(m.observed_runs),
                }))}
              />
            )}
          </Async>
        </Panel>
        <Panel title="Branches" sub="Threads by recorded branch">
          <Async query={threads} skeleton={<SkeletonRows label="Loading branches" />} isEmpty={() => !branches.length} compact>
            {() => <RankedBars label="Threads by branch" limit={6} items={branches.map(([b, n]) => ({ key: b, label: <span className="mono">{b}</span>, value: n }))} />}
          </Async>
        </Panel>
      </div>
    </>
  );
}
