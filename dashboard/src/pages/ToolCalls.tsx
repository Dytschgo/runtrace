import { useEffect, useMemo, useRef } from 'react';
import { ModelName } from '../components/model';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { StackedDays, type StackSeries } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';
import { AppLink, Async, ChartPanel, NoRecords, PageHeader, Panel, RankedBars, ScanNote, SelectField, Skeleton, SkeletonRows, Stat, StatRow, StatusBadge, Tag, Unknown, NotYetPage } from '../components/ui';
import { getEntities } from '../lib/api';
import { stackByDay, toolHeadline, toolStats, toolSummary, type ToolStat } from '../lib/analytics';
import { useFilters, useToolAggregates, useToolAnalysis, useToolHours, type ToolHour, useToolSummary } from '../lib/data';
import { isFuture } from '../lib/filters';
import { fmtCompact, fmtDateTime, fmtDuration, fmtInt, fmtPct, fmtShortDateTime, isKnown } from '../lib/format';
import type { ToolRow } from '../lib/entities';
import { useSettings } from '../lib/settings';
import type { Entity } from '../lib/types';
import { useUrl } from '../lib/url';
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
  const { query: scan, reading, progress, total: totalTools } = useToolAnalysis(f, params.get('scan') === 'all');
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
    return { data, series: STATUS_SERIES.filter((s) => present.has(s.key)) };
  }, [fromHours, hours.data, filtered, timezone]);
  const categories = useMemo(() => {
    const m = new Map<string, number>();
    if (aggregate.data) for (const s of aggregate.data) m.set(s.category, (m.get(s.category) ?? 0) + s.calls);
    else for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [aggregate.data, rows]);
  const categoryTotal = categories.reduce((t, [, n]) => t + n, 0);

  const statColumns: Column<ToolStat>[] = [
    { key: 'name', header: 'Tool', sort: (s) => s.name, render: (s) => <AppLink className="mono row-link" href={hrefPatch({ tool: tool === s.name ? null : s.name, offset: null })} ariaCurrent={tool === s.name ? 'true' : undefined}>{s.name}</AppLink> },
    { key: 'calls', header: 'Calls', align: 'end', sort: (s) => s.calls, render: (s) => fmtInt(s.calls) },
    { key: 'failed', header: 'Failed', align: 'end', sort: (s) => (s.statusKnown ? s.failed / s.statusKnown : null), render: (s) => (s.failed ? <>{fmtInt(s.failed)} <small className="fine">{fmtPct(s.failed / s.calls, 1)}</small></> : <span className="fine">0</span>) },
    { key: 'p50', header: 'Median', align: 'end', sort: (s) => s.p50, render: (s) => (s.p50 === null ? <Unknown label="Unknown" /> : fmtDuration(s.p50)) },
    { key: 'p95', header: 'p95', align: 'end', sort: (s) => s.p95, render: (s) => (s.p95 === null ? <Unknown label="Unknown" /> : fmtDuration(s.p95)) },
    { key: 'max', header: 'Slowest', align: 'end', sort: (s) => s.max, render: (s) => (s.max === null ? <Unknown label="Unknown" /> : fmtDuration(s.max)) },
    { key: 'chars', header: 'Stored characters', align: 'end', sort: (s) => s.chars, render: (s) => fmtCompact(s.chars) },
  ];

  const callColumns: Column<ToolRow>[] = [
    { key: 'name', header: 'Tool', sort: (r) => r.name, render: (r) => <AppLink className="mono row-link" href={hrefPatch({ call: r.source_id })}>{r.name}</AppLink> },
    { key: 'preview', header: 'Arguments', className: 'cell-preview', csv: (r) => r.preview, render: (r) => (r.preview ? <span className="mono cell-clip" title={r.preview}>{r.preview}</span> : <span className="fine">None recorded</span>) },
    { key: 'model', header: 'Model', sort: (r) => r.model, render: (r) => (r.model ? <ModelName model={r.model} /> : <span className="fine">Not recorded</span>) },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'exit', header: 'Exit', align: 'end', sort: (r) => r.exit, render: (r) => (r.exit === null ? (r.category === 'shell' ? <Unknown label="Unknown" why="No exit code recorded." /> : <span className="fine">n/a</span>) : r.exit === 0 ? '0' : <Tag tone="crit">{r.exit}</Tag>) },
    { key: 'duration', header: 'Time', align: 'end', sort: (r) => r.duration, render: (r) => (r.duration === null ? <Unknown label="Unknown" why="No completion time recorded." /> : fmtDuration(r.duration)) },
    { key: 'thread', header: 'Thread', render: (r) => (r.thread_id ? <AppLink className="link" href={hrefPage('Threads', { id: r.thread_id })}>Open</AppLink> : <span className="fine">None</span>) },
    { key: 'time', header: 'Started', sort: (r) => r.occurred_at, render: (r) => <time dateTime={r.occurred_at}>{fmtShortDateTime(r.occurred_at, timezone)}</time> },
  ];

  const hasFilter = !!(tool || status || category);

  if (isFuture(f)) return <NotYetPage title="Tool Calls" />;

  return (
    <>
      <PageHeader
        title="Tool Calls"
        lead="What ran and what failed."
        action={scan.data && <ScanNote scanned={scan.data.scanned} complete={scan.data.complete} noun="calls" total={totalTools} reading={reading} progress={progress} onExpand={() => set({ scan: 'all' })} />}
      />

      <Async query={scan} skeleton={<Skeleton height="6rem" label="Loading tool calls" />} isEmpty={(d) => !d.rows.length} empty={<Panel><NoRecords /></Panel>}>
        {() => (
          <>
            <StatRow label="Tool call summary">
              <Stat label="Calls" value={fmtInt(sum.calls)} sub={sum.sampled.calls ? sampleNote : `${fmtInt(stats.length)} distinct tools`} />
              <Stat label="Failed" value={sum.statusKnown ? fmtPct(sum.failed / sum.statusKnown, 1) : <Unknown label="Unknown" />} sub={`${fmtInt(sum.failed)} calls${sum.sampled.calls ? ` ${sampleNote}` : ''}`} tone={sum.failed ? 'crit' : undefined} />
              <Stat label="Shell non-zero exit" value={sum.exitKnown ? fmtPct(sum.nonZero / sum.exitKnown, 1) : <span className="stat-text fine">n/a</span>} sub={sum.shell ? `${fmtInt(sum.nonZero)} of ${fmtInt(sum.exitKnown)} with an exit code${sum.sampled.exit ? ` ${sampleNote}` : ''}` : sum.sampled.exit ? `No shell calls ${sampleNote}` : 'No shell calls here'} />
              <Stat label="Median time" value={sum.p50 === null ? <Unknown label="Unknown" /> : fmtDuration(sum.p50)} sub={[sum.p95 === null ? '' : `p95 ${fmtDuration(sum.p95)}`, sum.sampled.time ? sampleNote : ''].filter(Boolean).join(' · ') || undefined} />
            </StatRow>

            <div className="split">
              <ChartPanel
                className="grow-2"
                title="Calls per day"
                sub={fromHours || complete ? 'By status, in the display timezone' : `By status · ${sampleNote}`}
                chart={stack.data.length ? <StackedDays rows={stack.data} series={stack.series} height={220} /> : <NoRecords compact />}
                table={
                  <table>
                    <thead><tr><th scope="col">Day</th>{stack.series.map((s) => <th key={s.key} scope="col" className="num">{s.label}</th>)}</tr></thead>
                    <tbody>{stack.data.map((d) => <tr key={d.day}><td>{d.label}</td>{stack.series.map((s) => <td key={s.key} className="num">{fmtInt(Number(d[s.key] ?? 0))}</td>)}</tr>)}</tbody>
                  </table>
                }
              />
              <Panel className="grow-1" title="By category" sub={aggregate.data || complete ? 'Only built-in item types are classified' : `Only built-in item types are classified · ${sampleNote}`}>
                <RankedBars
                  label="Calls by category" total={categoryTotal}
                  items={categories.map(([c, n]) => ({
                    key: c, value: n, active: category === c, href: hrefPatch({ category: category === c ? null : c, offset: null }),
                    label: CATEGORY_LABEL[c] ?? c,
                  }))}
                />
              </Panel>
            </div>

            <Panel title="Tools" sub={aggregate.data ? 'All matching stored calls. Select a tool to filter the loaded calls below.' : 'Loaded calls only. Select a tool to filter the calls below.'} flush>
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
