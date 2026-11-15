import { useMemo } from 'react';
import { modelIcon } from '../lib/icons';
import { OTHER_COLOR, seriesColor, StackedDays, type StackSeries } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';
import { CHART_MODELS, MixBar, MixKey, TokenFacts, useTokenStack } from '../components/tokens';
import { ModelName } from '../components/model';
import { AppLink, Async, ChartPanel, CoverageBar, NoRecords, PageHeader, Panel, Segmented, ShareStrip, Skeleton, SkeletonRows, Stat, StatRow, Tokens, Unknown, NotYetPage } from '../components/ui';
import { percentile, stackByDay, tokenSummary, weeklyWhenLong } from '../lib/analytics';
import { useAgents, useFilters, useModels, useModelSlots, useModelTurns, useThreads } from '../lib/data';
import { inTimeRange, isFuture } from '../lib/filters';
import { fmtDuration, fmtInt, fmtPct, isKnown } from '../lib/format';
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
  const daily = useMemo(() => {
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
  // Past two months a bar per day is too thin, so the bars become weeks, and a day short of usage makes its week short too.
  const stack = useMemo(() => {
    const { rows, unit, weekOf } = weeklyWhenLong(daily.data, timezone);
    const partial = 'partial' in daily ? new Set([...(daily.partial as Set<string>)].map((k) => { const [day, ...rest] = k.split('|'); return `${weekOf.get(day) ?? day}|${rest.join('|')}`; })) : undefined;
    return { data: rows, series: daily.series, unit, partial };
  }, [daily, timezone]);
  const per = stack.unit === 'week' ? 'week' : 'day';

  const turnsKnown = rows.some((r) => isKnown(r.observed_provider_turns));
  const latencyKnown = rows.some((r) => isKnown(r.median_latency_ms));
  const mixKnown = rows.some((r) => isKnown(r.input_tokens) || isKnown(r.output_tokens));
  // Fields no model reported are said once, above the table, instead of a hatched cell in every row.
  const absent = [
    ['Model calls', rows.some((r) => isKnown(r.calls)), CALLS_WHY],
    ['Provider turns', turnsKnown, 'This service does not report provider turns yet.'],
    ['Input', rows.some((r) => isKnown(r.input_tokens)), NO_USAGE],
    ['Output', rows.some((r) => isKnown(r.output_tokens)), NO_USAGE],
    ['Turn time', latencyKnown, 'No completed turn with timing.'],
  ].filter(([, known]) => !known) as [string, boolean, string][];
  const columns: Column<Row>[] = [
    {
      key: 'model', header: 'Model', sort: (r) => r.name,
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
          {isKnown(r.total_tokens) && <span className="bar-cell-track" aria-hidden="true"><span style={{ inlineSize: `${r.share * 100}%`, background: seriesColor(r.model ? slots.get(r.model) : undefined) }} /></span>}
          {isKnown(r.total_tokens) && (r.complete_usage_turns ?? r.turns_with_usage ?? 0) < (r.observed_provider_turns ?? 0) && <span className="lower-bound" title="Some turns reported no complete total"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}
          {isKnown(r.total_tokens) ? <Tokens v={r.total_tokens} /> : (r.turns_with_usage ?? 0) > 0 ? <Unknown label="No complete total" why="Total is only computed for turns with complete usage." /> : <Unknown label="Not reported" why={NO_USAGE} />}
        </span>
      ),
    },
    ...(mixKnown ? [{
      key: 'mix', header: 'Token mix', className: 'wide-narrow', sort: (r: Row) => (isKnown(r.cached_input_tokens) && r.input_tokens ? r.cached_input_tokens / r.input_tokens : null), csv: () => null,
      render: (r: Row) => (
        <span className="mix-cell" title={mixTitle(r)}>
          <MixBar input={r.input_tokens} cached={r.cached_input_tokens} output={r.output_tokens} reasoning={r.reasoning_tokens} label={`${r.name} token mix`} />
          {isKnown(r.input_tokens) && <small>{isKnown(r.cached_input_tokens) && r.input_tokens ? `${fmtPct(r.cached_input_tokens / r.input_tokens)} of input cached` : 'No cache reported'}</small>}
        </span>
      ),
    }] : []),
    ...(turnsKnown ? [{
      key: 'turns', header: 'Provider turns', align: 'end' as const, sort: (r: Row) => r.observed_provider_turns ?? null,
      render: (r: Row) => {
        const n = r.observed_provider_turns ?? 0;
        const usage = r.turns_with_usage ?? 0;
        const complete = r.complete_usage_turns ?? 0;
        return (
          <span className="usage-cell">
            {n === 0 && (r.session_log_blocks ?? 0) > 0 ? <span className="fine" title="Tokens were read from session logs, by the hour. Those are not provider turns.">None · {fmtInt(r.session_log_blocks!)} log hours</span> : fmtInt(n)}
            {n > 0 && (usage < n || complete < usage) && (usage === 0
              ? <small>None reported usage</small>
              : <small>{fmtInt(usage)} reported{complete < usage ? `, ${fmtInt(complete)} in full` : ''}</small>)}
          </span>
        );
      },
    }] : []),
    ...(latencyKnown ? [{
      key: 'median', header: 'Turn time', align: 'end' as const, sort: (r: Row) => r.median_latency_ms ?? null,
      render: (r: Row) => (isKnown(r.median_latency_ms)
        ? <span className="cell-pair"><span title="Median turn">{fmtDuration(r.median_latency_ms)}</span>{isKnown(r.p95_latency_ms) && <small title="95th percentile turn">p95 {fmtDuration(r.p95_latency_ms)}</small>}</span>
        : <Unknown label="n/a" why="No completed turn with timing." />),
    }] : []),
    { key: 'threads', header: 'Threads', align: 'end', className: 'hide-narrow', sort: (r) => r.threads, render: (r) => <CountCell row={r} v={r.threads} /> },
    { key: 'agents', header: 'Sub-agents', align: 'end', className: 'hide-narrow', sort: (r) => r.agents, render: (r) => <CountCell row={r} v={r.agents} /> },
    // Every figure stays in the download.
    { key: 'runs', header: 'Runs', csvOnly: true, render: () => null, sort: (r) => r.observed_runs },
    { key: 'input', header: 'Input', csvOnly: true, render: () => null, sort: (r) => r.input_tokens ?? null },
    { key: 'cached', header: 'Cached input', csvOnly: true, render: () => null, sort: (r) => r.cached_input_tokens ?? null },
    { key: 'cache-write', header: 'Cache writes', csvOnly: true, render: () => null, sort: (r) => r.cache_write_tokens ?? null },
    { key: 'output', header: 'Output', csvOnly: true, render: () => null, sort: (r) => r.output_tokens ?? null },
    { key: 'reasoning', header: 'Reasoning', csvOnly: true, render: () => null, sort: (r) => r.reasoning_tokens ?? null },
    { key: 'p95', header: 'p95 turn', csvOnly: true, render: () => null, sort: (r) => r.p95_latency_ms ?? null },
    { key: 'subtime', header: 'Median sub-agent time', csvOnly: true, render: () => null, sort: (r) => r.median },
    { key: 'calls', header: 'Model calls', csvOnly: true, render: () => null, sort: (r) => r.calls ?? null },
  ];

  const top = rows.reduce<Row | undefined>((best, r) => (r.model && (!best || (hasTotals ? (r.total_tokens ?? -1) > (best.total_tokens ?? -1) : r.observed_runs > best.observed_runs)) ? r : best), undefined);

  if (isFuture(f)) return <NotYetPage title="Models" />;

  return (
    <>
      <PageHeader title="Models" lead={top && top.share > 0 ? <><span className="mono">{top.name}</span> did {fmtPct(top.share)} of the {hasTotals ? 'reported tokens' : 'runs'}{rows.filter((r) => r.model).length > 1 ? `, across ${fmtInt(rows.filter((r) => r.model).length)} models` : ''}.</> : 'Which models did the work.'} />
      <Async query={models} skeleton={<Skeleton height="6rem" label="Loading models" />} isEmpty={(d) => !d.length} empty={<Panel><NoRecords /></Panel>}>
        {() => (
          <>
            <Panel title={hasTotals ? 'Share of reported tokens' : 'Share of runs'} hint={hasTotals ? 'Complete-turn totals per requested model. A provider can serve a different model; only the requested one is recorded.' : 'Observed runs per requested model.'}>
              <ShareStrip
                label="Share by model" legend={8}
                note={hasTotals && rows.some((r) => (r.observed_provider_turns ?? 0) > (r.complete_usage_turns ?? 0)) ? `${fmtInt(rows.reduce((a, r) => a + (r.complete_usage_turns ?? 0), 0))} of ${fmtInt(rows.reduce((a, r) => a + (r.observed_provider_turns ?? 0), 0))} turns reported a total` : undefined}
                items={rows.map((r) => ({
                  key: r.name, text: r.name, value: hasTotals ? r.total_tokens ?? 0 : r.observed_runs, color: seriesColor(r.model ? slots.get(r.model) : undefined), muted: !r.model,
                  label: r.model ? <ModelName model={r.model} /> : <span className="mono">Not recorded</span>,
                }))}
              />
              <StatRow label="Model summary">
                <Stat label="Models" value={fmtInt(rows.filter((r) => r.model).length)} sub={`${fmtInt(rows.reduce((s, r) => s + r.observed_runs, 0))} runs`} />
                {(() => {
                  const fast = rows.filter((r) => r.model && isKnown(r.median_latency_ms) && (r.observed_provider_turns ?? 0) >= 3).sort((a, b) => a.median_latency_ms! - b.median_latency_ms!)[0];
                  return <Stat label="Fastest median turn" value={fast ? <span className="stat-text mono">{fast.name}</span> : <Unknown label="n/a" why="No model has three or more timed turns." />} sub={fast ? fmtDuration(fast.median_latency_ms!) : undefined} />;
                })()}
                <Stat label="Cached input" value={isKnown(summary.cached) && summary.input ? fmtPct(summary.cached / summary.input) : <Unknown why={NO_USAGE} />} sub="of all input tokens" />
                <Stat label="Turns with a total" value={(() => { const t = rows.reduce((a, r) => a + (r.observed_provider_turns ?? 0), 0); const c = rows.reduce((a, r) => a + (r.complete_usage_turns ?? 0), 0); return t ? fmtPct(c / t) : <Unknown why={NO_USAGE} />; })()} sub={resolvedKnown ? `${fmtInt(resolvedKnown)} with a resolved model` : 'Requested model only'} />
              </StatRow>
            </Panel>

            <Panel title="Model ledger" hint={<>Tokens are per provider turn, not per model call; model calls are not captured. Totals count only turns that reported one, so input can exceed them. The CSV holds every field.</>} action={mixKnown ? <MixKey /> : undefined} flush>
              {absent.length > 0 && <p className="table-gap">{absent.map(([name, , why]) => <span key={name}>{name} <Unknown why={why} /></span>)}<small>for every model</small></p>}
              <DataTable rows={rows} columns={columns} rowKey={(r) => r.name} caption="Usage by requested model" defaultSort={hasTokens ? { key: 'tokens', dir: 'desc' } : { key: 'runs', dir: 'desc' }} paged={false} exportName="runtrace-models" />
            </Panel>

            <div className="split">
              <ChartPanel
                className="grow-2"
                title={metric === 'tokens' && hasTokens ? `Tokens per ${per}, by model` : metric === 'turns' && hasTokens ? `Provider turns per ${per}, by model` : `Threads started per ${per}, by model`}
                hint={metric === 'tokens' && hasTokens ? 'Complete-turn totals only, in the display timezone. Partial token fields are in the ledger.' : 'In the display timezone.'}
                chart={metric === 'tokens' && hasTokens && !hasTotals ? <p className="fine">No complete token totals. Partial token fields are shown in the ledger.</p> : <Async query={metric === 'threads' || !hasTokens ? threads : turns as unknown as typeof threads} skeleton={<SkeletonRows label="Loading chart" />} isEmpty={() => !stack.data.length} compact>{() => <StackedDays rows={stack.data} series={stack.series} compactValues={metric === 'tokens'} legendByTotal />}</Async>}
                table={
                  <table>
                    <thead><tr><th scope="col">{per === 'week' ? 'Week of' : 'Day'}</th>{stack.series.map((s) => <th key={s.key} scope="col" className="num">{s.label}</th>)}</tr></thead>
                    <tbody>{stack.data.map((d) => <tr key={d.day}><td>{d.label}</td>{stack.series.map((s) => <td key={s.key} className="num">{metric === 'tokens' && stack.partial?.has(`${d.day}|${s.key}`) ? '≥ ' : ''}{fmtInt(Number(d[s.key] ?? 0))}</td>)}</tr>)}</tbody>
                  </table>
                }
                action={
                  <>
                    {hasTokens && (
                      <Segmented label="Chart measure" value={metric} onChange={(v) => set({ metric: v === 'tokens' ? null : v }, { replace: true })}
                        options={[{ value: 'tokens', label: 'Tokens' }, { value: 'turns', label: 'Turns' }, { value: 'threads', label: 'Threads' }]} />
                    )}
                    <AppLink className="link" href={hrefPage('Threads')}>All threads</AppLink>
                  </>
                }
              />
              <Panel className="grow-1" title="Token usage" sub={f.model ? <span className="mono">{f.model}</span> : 'All models in this view'}>
                <TokenFacts s={summary} />
              </Panel>
            </div>
          </>
        )}
      </Async>
    </>
  );
}

const exact = (v: number | null | undefined) => (isKnown(v) ? `${fmtInt(v)} tokens` : 'not reported');
/** Every token field of a row, exact, for the mix bar's hover. */
function mixTitle(r: Row) {
  const writes = isKnown(r.cache_write_observed_turns) && isKnown(r.observed_provider_turns) && r.observed_provider_turns > 0 ? ` (${fmtInt(r.cache_write_observed_turns)} of ${fmtInt(r.observed_provider_turns)} turns recorded)` : '';
  return [`Input: ${exact(r.input_tokens)}`, `Cached input: ${exact(r.cached_input_tokens)}`, `Cache writes: ${exact(r.cache_write_tokens)}${writes}`, `Output: ${exact(r.output_tokens)}`, `Reasoning: ${exact(r.reasoning_tokens)}`].join('\n');
}

function CountCell({ row, v }: { row: Row; v: number | null }) {
  if (!row.model) return <span className="sr-only">Does not apply: turns that name no model have no threads to count</span>;
  return v === null ? <span className="fine" aria-label="Loading">…</span> : <>{fmtInt(v)}</>;
}

function ModelGlyph({ model, color }: { model: string | null; color: string }) {
  const Icon = modelIcon(model);
  return <Icon size={14} aria-hidden="true" style={{ color }} />;
}
