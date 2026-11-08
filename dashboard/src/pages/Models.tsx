import { useMemo } from 'react';
import { modelIcon } from '../lib/icons';
import { OTHER_COLOR, seriesColor, StackedDays, type StackSeries } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';
import { CHART_MODELS, TokenFacts, useTokenStack } from '../components/tokens';
import { AppLink, Async, ChartPanel, CoverageBar, NoRecords, PageHeader, Panel, Segmented, Skeleton, SkeletonRows, Stat, StatRow, Tag, Tokens, Unknown, Val, NotYetPage } from '../components/ui';
import { percentile, stackByDay, tokenSummary } from '../lib/analytics';
import { useAgents, useFilters, useModels, useModelSlots, useModelTurns, useThreads } from '../lib/data';
import { inTimeRange, isFuture } from '../lib/filters';
import { fmtCompact, fmtDuration, fmtInt, fmtPct, isKnown } from '../lib/format';
import { useSettings } from '../lib/settings';
import type { ModelRow } from '../lib/types';
import { useUrl } from '../lib/url';


interface Row extends ModelRow { name: string; threads: number | null; agents: number | null; median: number | null; share: number }

const CALLS_WHY = 'A provider turn can contain several model calls. Only turns are recorded, so a turn is never counted as a call.';
const NO_USAGE = 'This token field was not recorded.';

export default function Models() {
  const { params, set, hrefPage, hrefPatch } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const models = useModels(f);
  const slots = useModelSlots();
  const threads = useThreads(f);
  const agents = useAgents(f);
  const turns = useModelTurns({ ...f, model: undefined });

  const rows: Row[] = useMemo(() => {
    const durations = new Map<string, number[]>();
    for (const a of agents.data?.rows ?? []) {
      if (a.model && a.duration !== null && inTimeRange(a.occurred_at, f)) (durations.get(a.model) ?? durations.set(a.model, []).get(a.model)!).push(a.duration);
    }
    const all = models.data ?? [];
    const tokenTotal = all.reduce((s, m) => s + (m.total_tokens ?? 0), 0);
    const runTotal = all.reduce((s, m) => s + m.observed_runs, 0);
    return all.map((m) => {
      // Counted by the service with the model list. Rows with no model name have no per-model count.
      return {
        ...m, name: m.model ?? 'Model not recorded',
        threads: m.model ? m.observed_threads ?? null : null, agents: m.model ? m.observed_agents ?? null : null,
        median: m.model ? percentile(durations.get(m.model) ?? [], 0.5) : null,
        share: all.some((row) => isKnown(row.total_tokens)) ? (tokenTotal ? (m.total_tokens ?? 0) / tokenTotal : 0) : runTotal ? m.observed_runs / runTotal : 0,
      };
    });
  }, [models.data, agents.data, f]);

  const summary = useMemo(() => tokenSummary((models.data ?? []).filter((m) => !f.model || m.model === f.model)), [models.data, f.model]);
  const hasTokens = [summary.total,summary.input,summary.output,summary.cached,summary.cacheWrite,summary.reasoning].some(isKnown);
  const hasTotals = summary.total !== null;
  const resolvedKnown = (turns.data?.rows ?? []).filter((t) => t.resolved !== null).length;

  const metric = (params.get('metric') ?? 'tokens') as 'tokens' | 'turns' | 'threads';
  const tokenStack = useTokenStack(turns.data?.rows ?? [], slots, timezone);
  const windowThreads = useMemo(() => (threads.data?.rows ?? []).filter((t) => inTimeRange(t.occurred_at, f)), [threads.data, f]);
  const stack = useMemo(() => {
    if (metric === 'tokens' && hasTokens) return tokenStack;
    const visible = new Set([...slots.keys()].slice(0, CHART_MODELS));
    const name = (m: string | null) => (m && visible.has(m) ? m : 'Other');
    const data = metric === 'turns' && hasTokens
      ? stackByDay((turns.data?.rows ?? []).filter((t) => !t.log), (t) => t.occurred_at, (t) => name(t.model), timezone)
      : stackByDay(windowThreads, (t) => t.occurred_at, (t) => name(t.model), timezone);
    const present = new Set(data.flatMap((d) => Object.keys(d)));
    const series: StackSeries[] = [...visible].filter((m) => present.has(m)).map((m) => ({ key: m, label: m, color: seriesColor(slots.get(m)) }));
    if (present.has('Other')) series.push({ key: 'Other', label: 'Other', color: OTHER_COLOR });
    return { data, series };
  }, [metric, hasTokens, tokenStack, turns.data, windowThreads, slots, timezone]);

  const columns: Column<Row>[] = [
    {
      key: 'model', header: 'Requested model', sort: (r) => r.name,
      render: (r) => (
        <span className="cell-model">
          <ModelGlyph model={r.model} color={seriesColor(r.model ? slots.get(r.model) : undefined)} />
          {r.model
            ? <AppLink className="mono row-link" href={hrefPatch({ model: f.model === r.model ? null : r.model })} ariaCurrent={f.model === r.model ? 'true' : undefined} title={f.model === r.model ? 'Clear this model filter' : 'Filter the dashboard to this model'}>{r.name}</AppLink>
            : <span className="mono fine" title="Usage was reported for these turns but no model was recorded.">{r.name}</span>}
        </span>
      ),
    },
    {
      key: 'tokens', header: 'Total tokens', align: 'end', sort: (r) => r.total_tokens ?? null,
      render: (r) => (
        <span className="token-cell">
          <span className="bar-cell-track" aria-hidden="true"><span style={{ inlineSize: `${r.share * 100}%` }} /></span>
          {isKnown(r.total_tokens) && (r.complete_usage_turns ?? r.turns_with_usage ?? 0) < (r.observed_provider_turns ?? 0) && <span className="lower-bound" title="Some turns reported no complete total"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}
          <Tokens v={r.total_tokens} why={(r.turns_with_usage ?? 0) > 0 ? 'Total is only computed for turns with complete usage.' : NO_USAGE} />
        </span>
      ),
    },
    { key: 'runs', header: 'Runs', align: 'end', sort: (r) => r.observed_runs, render: (r) => fmtInt(r.observed_runs) },
    { key: 'threads', header: 'Threads', align: 'end', sort: (r) => r.threads, render: (r) => <CountCell row={r} v={r.threads} /> },
    { key: 'agents', header: 'Sub-agents', align: 'end', sort: (r) => r.agents, render: (r) => <CountCell row={r} v={r.agents} /> },
    { key: 'subtime', header: 'Median sub-agent time', align: 'end', sort: (r) => r.median, render: (r) => (r.median === null ? <span className="fine">None timed</span> : fmtDuration(r.median)) },
  ];
  // Newer measures join the ledger when the service reports them. Hidden when all rows are null, and then stated once.
  const measures: { key: string; header: string; get: (r: Row) => number | null | undefined; why: string; render?: (r: Row) => React.ReactNode }[] = [
    { key: 'calls', header: 'Model calls', get: (r) => r.calls, why: CALLS_WHY },
    {
      key: 'turns', header: 'Provider turns', get: (r) => r.observed_provider_turns, why: 'This service does not report provider turns yet.',
      render: (r) => {
        const n = r.observed_provider_turns ?? 0;
        const usage = r.turns_with_usage ?? 0;
        const complete = r.complete_usage_turns ?? 0;
        return (
          <span className="usage-cell">
            {n === 0 && (r.session_log_blocks ?? 0) > 0 ? <span className="fine" title="Tokens were read from session logs, by the hour. Those are not provider turns.">None · {fmtInt(r.session_log_blocks!)} log hours</span> : fmtInt(n)}
            {n > 0 && <CoverageBar known={usage} total={n} label={`${r.name}, turns reporting usage`} />}
            {n > 0 && (usage === 0
              ? <small>None reported usage</small>
              : complete < usage ? <small>{fmtInt(usage)} reported, {fmtInt(complete)} in full</small> : <small>{fmtInt(usage)} reported</small>)}
          </span>
        );
      },
    },
    { key: 'input', header: 'Input', get: (r) => r.input_tokens, why: NO_USAGE, render: (r) => <Tokens v={r.input_tokens} why={NO_USAGE} /> },
    {
      key: 'cached', header: 'Cached input', get: (r) => r.cached_input_tokens, why: NO_USAGE,
      render: (r) => (isKnown(r.cached_input_tokens)
        ? <span title={`${fmtInt(r.cached_input_tokens)} tokens`}>{r.input_tokens ? fmtPct(r.cached_input_tokens / r.input_tokens) : fmtCompact(r.cached_input_tokens)}</span>
        : <Unknown label="n/a" why={NO_USAGE} />),
    },
    {
      key: 'cache-write', header: 'Cache writes', get: (r) => r.cache_write_tokens, why: 'No cache-write usage was reported.',
      render: (r) => <span className="usage-cell"><Tokens v={r.cache_write_tokens} why="No cache-write usage was reported." />{isKnown(r.cache_write_observed_turns) && isKnown(r.observed_provider_turns) && r.observed_provider_turns > 0 && <small>{fmtInt(r.cache_write_observed_turns)} of {fmtInt(r.observed_provider_turns)} recorded</small>}</span>,
    },
    { key: 'output', header: 'Output', get: (r) => r.output_tokens, why: NO_USAGE, render: (r) => <Tokens v={r.output_tokens} why={NO_USAGE} /> },
    { key: 'reasoning', header: 'Reasoning', get: (r) => r.reasoning_tokens, why: NO_USAGE, render: (r) => <Tokens v={r.reasoning_tokens} why={NO_USAGE} /> },
    { key: 'median', header: 'Median turn', get: (r) => r.median_latency_ms, why: 'No completed turn with timing.', render: (r) => (isKnown(r.median_latency_ms) ? fmtDuration(r.median_latency_ms) : <Unknown label="n/a" why="No completed turn with timing." />) },
    { key: 'p95', header: 'p95 turn', get: (r) => r.p95_latency_ms, why: 'No completed turn with timing.', render: (r) => (isKnown(r.p95_latency_ms) ? fmtDuration(r.p95_latency_ms) : <Unknown label="n/a" why="No completed turn with timing." />) },
  ];
  const absent = measures.filter((m) => !rows.some((r) => isKnown(m.get(r))));
  const insertAt = 2;
  columns.splice(insertAt, 0, ...measures.filter((m) => !absent.includes(m)).map((m): Column<Row> => ({
    key: m.key, header: m.header, align: 'end', sort: (r) => m.get(r) ?? null, render: m.render ?? ((r) => <Val v={m.get(r)} why={m.why} />),
  })));

  const top = rows.reduce<Row | undefined>((best, r) => (r.model && (!best || (hasTotals ? (r.total_tokens ?? -1) > (best.total_tokens ?? -1) : r.observed_runs > best.observed_runs)) ? r : best), undefined);

  if (isFuture(f)) return <NotYetPage title="Models" />;

  return (
    <>
      <PageHeader title="Models" lead="Tokens are per provider turn, not per model call." />
      <Async query={models} skeleton={<Skeleton height="6rem" label="Loading models" />} isEmpty={(d) => !d.length} empty={<Panel><NoRecords /></Panel>}>
        {() => (
          <>
            <StatRow label="Model summary">
              <Stat label="Models requested" value={fmtInt(rows.filter((r) => r.model).length)} sub={`across ${fmtInt(rows.reduce((s, r) => s + r.observed_runs, 0))} observed runs`} />
              <Stat label={hasTotals ? 'Most tokens' : 'Most requested'} value={<span className="stat-text mono">{top?.name}</span>} sub={top ? `${fmtPct(top.share)} of ${hasTotals ? 'complete-turn tokens' : 'runs'}` : undefined} />
              <Stat label="Resolved model" value={resolvedKnown ? fmtInt(resolvedKnown) : <Unknown why="Only the requested model is recorded." />} sub={resolvedKnown ? 'Turns with a resolved model' : 'A provider can serve a different model'} />
              <Stat label="Model calls" value={rows.some((r) => isKnown(r.calls)) ? 'Partial' : <Unknown why={CALLS_WHY} />} sub="Not the same as provider turns" />
            </StatRow>

            <Panel title="Model ledger" sub="Counts follow the current filters. Total counts only turns that reported one, so input can exceed it." flush>
              {absent.length > 0 && (
                <p className="table-gap">{absent.map((m) => <span key={m.key}>{m.header} <Unknown why={m.why} /></span>)}<small>for every model</small></p>
              )}
              <DataTable rows={rows} columns={columns} rowKey={(r) => r.name} caption="Usage by requested model" defaultSort={hasTokens ? { key: 'tokens', dir: 'desc' } : { key: 'runs', dir: 'desc' }} paged={false} exportName="runtrace-models" />
            </Panel>

            <div className="split">
              <ChartPanel
                className="grow-2"
                title={metric === 'tokens' && hasTokens ? 'Tokens per day, by model' : metric === 'turns' && hasTokens ? 'Provider turns per day, by model' : 'Threads started per day, by model'}
                sub={metric === 'tokens' && hasTokens ? 'Complete-turn totals only; partial token fields are shown in the ledger' : 'In the display timezone'}
                chart={metric === 'tokens' && hasTokens && !hasTotals ? <p className="fine">No complete token totals. Partial token fields are shown in the ledger.</p> : <Async query={metric === 'threads' || !hasTokens ? threads : turns as unknown as typeof threads} skeleton={<SkeletonRows label="Loading chart" />} isEmpty={() => !stack.data.length} compact>{() => <StackedDays rows={stack.data} series={stack.series} compactValues={metric === 'tokens'} />}</Async>}
                table={
                  <table>
                    <thead><tr><th scope="col">Day</th>{stack.series.map((s) => <th key={s.key} scope="col" className="num">{s.label}</th>)}</tr></thead>
                    <tbody>{stack.data.map((d) => <tr key={d.day}><td>{d.label}</td>{stack.series.map((s) => <td key={s.key} className="num">{metric === 'tokens' && 'partial' in stack && (stack.partial as Set<string>).has(`${d.day}|${s.key}`) ? '≥ ' : ''}{fmtInt(Number(d[s.key] ?? 0))}</td>)}</tr>)}</tbody>
                  </table>
                }
                action={
                  <>
                    {hasTokens && (
                      <Segmented label="Chart measure" value={metric} onChange={(v) => set({ metric: v === 'tokens' ? null : v }, { replace: true })}
                        options={[{ value: 'tokens', label: 'Tokens' }, { value: 'turns', label: 'Turns' }, { value: 'threads', label: 'Threads' }]} />
                    )}
                    <AppLink className="link" href={hrefPage('Threads')}>Threads</AppLink>
                  </>
                }
              />
              <Panel className="grow-1" title="Token usage" sub={f.model ? <span className="mono">{f.model}</span> : 'All models in this view'}>
                <TokenFacts s={summary} />
              </Panel>
            </div>
            {hasTokens && <p className="fine">Unattributed turns are counted in totals but have no model. <Tag>Provider turn</Tag> is one main-agent turn as the provider reported it.</p>}
          </>
        )}
      </Async>
    </>
  );
}

function CountCell({ row, v }: { row: Row; v: number | null }) {
  if (!row.model) return <span className="fine" title="This cannot be counted without a model.">n/a</span>;
  return v === null ? <span className="fine" aria-label="Loading">…</span> : <>{fmtInt(v)}</>;
}

function ModelGlyph({ model, color }: { model: string | null; color: string }) {
  const Icon = modelIcon(model);
  return <Icon size={14} aria-hidden="true" style={{ color }} />;
}
