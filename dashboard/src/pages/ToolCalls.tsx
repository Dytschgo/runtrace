import { useEffect, useMemo, useRef } from 'react';
import { ModelName } from '../components/model';
import { useQuery } from '@tanstack/react-query';
import { X, XCircle } from 'lucide-react';
import { StackedDays, type StackSeries } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';
import { AppLink, Async, ChartPanel, NoRecords, PageHeader, Panel, RankedBars, ScanNote, SelectField, Skeleton, SkeletonRows, Stat, StatRow, StatusBadge, Tag, Unknown, NotYetPage } from '../components/ui';
import { getEntities } from '../lib/api';
import { stackByDay, toolHeadline, weeklyWhenLong, toolStats, toolSummary, type ToolStat } from '../lib/analytics';
import { useFilters, useToolAggregates, useToolAnalysis, useToolHours, type ToolHour, useToolSummary } from '../lib/data';
import { isFuture } from '../lib/filters';
import { fmtCompact, fmtDateTime, fmtDuration, fmtInt, fmtPct, fmtShortDateTime, isKnown } from '../lib/format';
import type { ToolRow } from '../lib/entities';
import { useSettings } from '../lib/settings';
import type { Entity } from '../lib/types';
import { useUrl } from '../lib/url';
import { toolIcon } from '../lib/icons';
import { ToolContent } from './Threads';

const STATUS_SERIES: StackSeries[] = [
  { key: 'completed', label: 'Completed', color: 'oklch(0.52 0.006 70)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--warn)' },
  { key: 'failed', label: 'Failed', color: 'var(--crit)' },
  { key: 'running', label: 'Running', color: 'var(--accent)' },
  { key: 'unknown', label: 'Status unknown', color: 'oklch(0.38 0.006 70)' },
];
const CATEGORY_LABEL: Record<string, string> = { shell: 'Shell', file_write: 'File changes', search: 'Search', unknown: 'Uncategorised' };

export default function ToolCalls() {
  const { params, set, hrefPatch, hrefPage } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const { query: scan, reading, progress, total: totalTools, failed: scanFailed, retryFull } = useToolAnalysis(f, params.get('scan') === 'all');
  const tool = params.get('tool') ?? '';
  const status = params.get('status') ?? '';
  const category = params.get('category') ?? '';
  const call = params.get('call');

  const rows = scan.data?.rows ?? [];
  const aggregate = useToolAggregates(f);
  const stats = useMemo(() => aggregate.data ?? toolStats(rows), [aggregate.data, rows]);
  const filtered = useMemo(() => rows.filter((r) =>
    (!tool || r.name === tool) && (!status || (status === 'unknown' ? r.status === null : r.status === status)) && (!category || r.category === category)), [rows, tool, status, category]);
  const complete = scan.data?.complete !== false;
  const fullSummary = useToolSummary(f, !tool && !category && !status);
  const sum = useMemo(
    () => toolHeadline(toolSummary(filtered), complete, { full: fullSummary.data, stats: aggregate.data, tool, category, status }),
    [filtered, complete, fullSummary.data, aggregate.data, tool, category, status],
  );
  const sampleNote = `in the latest ${fmtInt(rows.length)} loaded`;
  // With nothing chosen, the chart and categories cover every call in the window. A chosen tool, status or category can only be read from the loaded calls, and says so.
  const hours = useToolHours(f, !tool && !status && !category);
  const fromHours = !tool && !status && !category && !!hours.data;
  const stack = useMemo(() => {
    const data = fromHours
      ? stackByDay(hours.data!.flatMap((h) => STATUS_SERIES.flatMap((s) => (h[s.key as keyof ToolHour] ? [{ at: h.hour, status: s.key, n: Number(h[s.key as keyof ToolHour]) }] : []))), (r) => r.at, (r) => r.status, timezone, (r) => r.n)
      : stackByDay(filtered, (r) => r.occurred_at, (r) => r.status ?? 'unknown', timezone);
    const present = new Set(data.flatMap((d) => Object.keys(d)));
    const { rows: bars, unit } = weeklyWhenLong(data, timezone);
    return { data: bars, unit, series: STATUS_SERIES.filter((s) => present.has(s.key)) };
  }, [fromHours, hours.data, filtered, timezone]);
  const categories = useMemo(() => {
    const m = new Map<string, number>();
    if (aggregate.data) for (const s of aggregate.data) m.set(s.category, (m.get(s.category) ?? 0) + s.calls);
    else for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [aggregate.data, rows]);
  const categoryTotal = categories.reduce((t, [, n]) => t + n, 0);

  const maxCalls = Math.max(1, ...stats.map((x) => x.calls));
  const statColumns: Column<ToolStat>[] = [
    { key: 'name', header: 'Tool', sort: (s) => s.name, render: (s) => { const Icon = toolIcon(s.name); return <AppLink className="mono row-link" href={hrefPatch({ tool: tool === s.name ? null : s.name, offset: null })} ariaCurrent={tool === s.name ? 'true' : undefined}><Icon size={13} aria-hidden="true" className="row-link-lead" />{s.name}</AppLink>; } },
    { key: 'calls', header: 'Calls', align: 'end', sort: (s) => s.calls, render: (s) => <span className="token-cell"><span className="bar-cell-track" aria-hidden="true"><span style={{ inlineSize: `${(s.calls / maxCalls) * 100}%` }} /></span>{fmtInt(s.calls)}</span> },
    {
      key: 'failed', header: 'Failed', align: 'end', sort: (s) => (s.statusKnown ? s.failed / s.statusKnown : null),
      render: (s) => (s.failed
        ? <AppLink className="fail-cell" href={hrefPatch({ tool: s.name, status: 'failed', offset: null })} title={`Show the failed ${s.name} calls`}><span className="fail-track" aria-hidden="true"><span style={{ inlineSize: `${(s.failed / s.calls) * 100}%` }} /></span><b><XCircle size={11} aria-hidden="true" /> {fmtPct(s.failed / s.calls, 1)}</b><small>{fmtInt(s.failed)}</small></AppLink>
        : <span className="dim">0</span>),
    },
    { key: 'p50', header: 'Time', align: 'end', sort: (s) => s.p50, render: (s) => (s.p50 === null ? <Unknown label="Unknown" /> : <span className="cell-pair"><span title="Median">{fmtDuration(s.p50)}</span>{s.p95 !== null && <small title="95th percentile">p95 {fmtDuration(s.p95)}</small>}</span>) },
    { key: 'p95', header: 'p95', csvOnly: true, sort: (s) => s.p95, render: () => null },
    { key: 'max', header: 'Slowest', csvOnly: true, sort: (s) => s.max, render: () => null },
    { key: 'chars', header: 'Stored characters', csvOnly: true, sort: (s) => s.chars, render: () => null },
  ];

  const callColumns: Column<ToolRow>[] = [
    { key: 'name', header: 'Tool', sort: (r) => r.name, render: (r) => { const Icon = toolIcon(r.name); return <AppLink className="mono row-link" href={hrefPatch({ call: r.source_id })}><Icon size={13} aria-hidden="true" className="row-link-lead" />{r.name}</AppLink>; } },
    { key: 'preview', header: 'Arguments', className: 'cell-preview wide-narrow', csv: (r) => r.preview, render: (r) => (r.preview ? <span className="mono cell-clip" title={r.preview}>{middle(r.preview)}</span> : <span className="fine">None recorded</span>) },
    { key: 'model', header: 'Model', className: 'wide-narrow', sort: (r) => r.model, render: (r) => (r.model ? <ModelName model={r.model} /> : <Unknown label="Not recorded" why="The call did not record which model made it." />) },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'exit', header: 'Exit', align: 'end', sort: (r) => r.exit, render: (r) => (r.exit === null ? (r.category === 'shell' ? <Unknown label="Unknown" why="No exit code recorded." /> : <span className="dim" aria-label="Does not apply" title="Only shell commands have an exit code">–</span>) : r.exit === 0 ? '0' : <Tag tone="crit">{r.exit}</Tag>) },
    { key: 'duration', header: 'Time', align: 'end', sort: (r) => r.duration, render: (r) => (r.duration === null ? <Unknown label="Unknown" why="No completion time recorded." /> : fmtDuration(r.duration)) },
    { key: 'thread', header: 'Thread', render: (r) => (r.thread_id ? <AppLink className="link" href={hrefPage('Threads', { id: r.thread_id })}>Open thread</AppLink> : <span className="fine">None</span>) },
    { key: 'time', header: 'Started', sort: (r) => r.occurred_at, render: (r) => <time dateTime={r.occurred_at}>{fmtShortDateTime(r.occurred_at, timezone)}</time> },
  ];

  const hasFilter = !!(tool || status || category);

  if (isFuture(f)) return <NotYetPage title="Tool Calls" />;

  return (
    <>
      <PageHeader
        title="Tool Calls"
        lead={(() => {
          const worst = [...stats].filter((x) => x.failed > 0 && x.calls >= 5).sort((a, b) => b.failed / b.calls - a.failed / a.calls)[0];
          return worst ? <><span className="mono">{worst.name}</span> fails about 1 in {Math.max(1, Math.round(worst.calls / worst.failed))} calls; {stats.filter((x) => x !== worst).some((x) => x.failed) ? 'the others fail less often' : 'no other tool recorded a failure in this window'}.</> : stats.length ? 'No tool failed in this view.' : 'What ran and what failed.';
        })()}
        action={scan.data && <ScanNote scanned={scan.data.scanned} complete={scan.data.complete} noun="calls" total={totalTools} reading={reading} progress={progress} failed={scanFailed} onRetry={retryFull} onExpand={() => set({ scan: 'all' })} />}
      />

      <Async query={scan} skeleton={<Skeleton height="6rem" label="Loading tool calls" />} isEmpty={(d) => !d.rows.length} empty={<Panel><NoRecords /></Panel>}>
        {() => (
          <>
            <StatRow label="Tool call summary">
              <Stat label="Calls" value={fmtInt(sum.calls)} sub={sum.sampled.calls ? sampleNote : `${fmtInt(stats.length)} distinct tools`} />
              <Stat label="Failed" value={sum.statusKnown ? (sum.failed ? <AppLink className="stat-link" href={hrefPatch({ status: status === 'failed' ? null : 'failed', offset: null })} title="Show only failed calls"><XCircle size={16} aria-hidden="true" className="stat-icon" />{fmtPct(sum.failed / sum.statusKnown, 1)}</AppLink> : fmtPct(0, 1)) : <Unknown label="Unknown" />} sub={<>{fmtInt(sum.failed)} calls{sum.sampled.calls ? ` ${sampleNote}` : ''}{sum.exitKnown ? <> · {fmtPct(sum.nonZero / sum.exitKnown, 1)} of shell commands exit non-zero</> : null}</>} tone={sum.failed ? 'crit' : undefined} />
              <Stat label="Median time" value={sum.p50 === null ? <Unknown label="Unknown" /> : fmtDuration(sum.p50)} sub={[sum.p95 === null ? '' : `p95 ${fmtDuration(sum.p95)}`, sum.sampled.time ? sampleNote : ''].filter(Boolean).join(' · ') || undefined} />
            </StatRow>

            <div className="split">
              <ChartPanel
                className="grow-2"
                title={stack.unit === 'week' ? 'Calls per week' : 'Calls per day'}
                sub={fromHours || complete ? 'By status, in the display timezone' : `By status · ${sampleNote}`}
                chart={stack.data.length ? <StackedDays rows={stack.data} series={stack.series} height={220} /> : <NoRecords compact />}
                table={
                  <table>
                    <thead><tr><th scope="col">{stack.unit === 'week' ? 'Week of' : 'Day'}</th>{stack.series.map((s) => <th key={s.key} scope="col" className="num">{s.label}</th>)}</tr></thead>
                    <tbody>{stack.data.map((d) => <tr key={d.day}><td>{d.label}</td>{stack.series.map((s) => <td key={s.key} className="num">{fmtInt(Number(d[s.key] ?? 0))}</td>)}</tr>)}</tbody>
                  </table>
                }
              />
              <Panel className="grow-1" title="By category" hint={aggregate.data || complete ? 'Only built-in item types are classified' : `Only built-in item types are classified · ${sampleNote}`}>
                <RankedBars
                  label="Calls by category" total={categoryTotal}
                  items={categories.map(([c, n]) => ({
                    key: c, value: n, active: category === c, href: hrefPatch({ category: category === c ? null : c, offset: null }),
                    label: CATEGORY_LABEL[c] ?? c,
                  }))}
                />
              </Panel>
            </div>

            <Panel title="Tools" hint={aggregate.data ? 'All matching stored calls. Select a tool to filter the loaded calls below.' : 'Loaded calls only. Select a tool to filter the calls below.'} flush>
              <DataTable rows={stats} columns={statColumns} rowKey={(s) => s.name} caption="Statistics by tool" prefix="ts" defaultLimit={10} defaultSort={{ key: 'calls', dir: 'desc' }} exportName="runtrace-tools" />
            </Panel>

            <Panel
              title="Calls"
              sub={hasFilter ? `${fmtInt(filtered.length)} match the filters` : 'Newest first'}
              action={
                <div className="toolbar">
                  <SelectField label="Tool" hideLabel value={tool} onChange={(v) => set({ tool: v, offset: null })} options={[{ value: '', label: 'All tools' }, ...stats.map((s) => ({ value: s.name, label: s.name }))]} />
                  <SelectField label="Status" hideLabel value={status} onChange={(v) => set({ status: v, offset: null })} options={[{ value: '', label: 'Any status' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'completed', label: 'Completed' }, { value: 'running', label: 'Running' }, { value: 'unknown', label: 'Unknown' }]} />
                </div>
              }
              flush
            >
              <DataTable
                rows={filtered} columns={callColumns} rowKey={(r) => r.id} caption="Tool calls" defaultSort={{ key: 'time', dir: 'desc' }} exportName="runtrace-tool-calls"
                empty={<NoRecords />}
              />
            </Panel>
          </>
        )}
      </Async>

      {call && <CallDialog id={call} onClose={() => set({ call: null })} />}
    </>
  );
}

function CallDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { hrefPage } = useUrl();
  const { timezone } = useSettings();
  const titleId = 'call-title';
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const q = useQuery({
    queryKey: ['tool-call', id],
    queryFn: async ({ signal }) => (await getEntities<Entity>('tool-calls', new URLSearchParams({ id, limit: '1', include_content: 'true' }), signal))[0] ?? null,
  });
  const e = q.data;
  const d = e?.data ?? {};
  return (
    <dialog ref={ref} className="dialog dialog-wide" onClose={onClose} aria-labelledby={titleId}>
      <header className="dialog-head">
        <h2 id={titleId} className="mono">{typeof d.tool_name === 'string' ? d.tool_name : 'Tool call'}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close tool call"><X size={15} aria-hidden="true" /></button>
      </header>
      <div className="dialog-body">
        <Async query={q} skeleton={<SkeletonRows rows={4} label="Loading tool call" />} isEmpty={(r) => !r} compact>
          {(row) => (
            <>
              <dl className="facts facts-grid">
                <div><dt>Status</dt><dd><StatusBadge status={typeof d.status === 'string' ? d.status : null} /></dd></div>
                <div><dt>Exit code</dt><dd>{isKnown(d.exit_code) ? d.exit_code : <span className="fine">Not recorded</span>}</dd></div>
                <div><dt>Started</dt><dd>{fmtDateTime(row!.occurred_at, timezone)}</dd></div>
                <div><dt>Redactions</dt><dd>{isKnown(d.redaction_count) ? fmtInt(d.redaction_count) : <Unknown label="Unknown" />}</dd></div>
              </dl>
              <ToolContent data={d} />
              {row!.thread_id && <AppLink className="btn" href={hrefPage('Threads', { id: row!.thread_id })}>Open thread</AppLink>}
            </>
          )}
        </Async>
      </div>
    </dialog>
  );
}

/** Long arguments keep both ends, where the command and its target usually are. */
function middle(text: string, max = 64) {
  return text.length <= max ? text : `${text.slice(0, max - 22)}…${text.slice(-20)}`;
}
