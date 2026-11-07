import { hasTurnUsage } from '../lib/entities';
import { useMemo } from 'react';
import { Bot, Coins, FileText, Globe, MessageSquare, MessageSquareReply, Play, Wrench, type LucideIcon } from 'lucide-react';
import { ActivityHeatmap, ColumnChart } from '../components/charts';
import { Pager } from '../components/DataTable';
import { AppLink, Async, ChartPanel, EmptyState, NoRecords, PageHeader, Panel, Segmented, Skeleton, SkeletonRows, Stat, StatRow, StatusBadge } from '../components/ui';
import { bucketActivity, buildHeatmap } from '../lib/analytics';
import { useFilters, useHourly, useOverview, useTimelinePage } from '../lib/data';
import { contentField, parseContent, toTool, toTurn } from '../lib/entities';
import { fmtClock, fmtCompact, fmtDay, fmtInt, isKnown, cleanText, repairText } from '../lib/format';
import { useSettings } from '../lib/settings';
import type { Entity } from '../lib/types';
import { useUrl } from '../lib/url';

export const KIND: Record<string, { label: string; icon: LucideIcon }> = {
  prompt: { label: 'Prompt', icon: MessageSquare },
  answer: { label: 'Answer', icon: MessageSquareReply },
  run: { label: 'Run', icon: Play },
  tool: { label: 'Tool call', icon: Wrench },
  agent: { label: 'Sub-agent', icon: Bot },
  thread: { label: 'Thread', icon: FileText },
  model_turn: { label: 'Turn', icon: Coins },
  external_request: { label: 'Request', icon: Globe },
};

const FEED_KINDS = ['all', 'prompt', 'answer', 'run', 'model_turn', 'tool', 'agent', 'thread'] as const;

function feedText(r: Entity): string {
  const d = r.data ?? {};
  if (r.kind === 'tool') {
    const preview = toTool(r).preview;
    return preview ? `${String(d.tool_name ?? 'tool')} · ${preview}` : String(d.tool_name ?? 'tool');
  }
  if (r.kind === 'model_turn') {
    const t = toTurn(r);
    return `${t.model ?? 'Model not recorded'} · ${t.total === null ? (hasTurnUsage(t) ? 'partial usage; total unavailable' : 'no token fields recorded') : `${fmtCompact(t.total)} tokens`}`;
  }
  if (r.kind === 'run') return `${String(d.requested_model ?? 'Model unknown')}${d.provider ? ` · ${String(d.provider)}` : ''}`;
  if (r.kind === 'thread') return repairText(String(d.title ?? 'Untitled thread'));
  if (r.kind === 'project') return repairText(String(d.name ?? r.source_id));
  if (r.kind === 'instance') return String(d.display_name ?? r.source_id);
  if (r.kind === 'agent') return contentField(parseContent(d).fields?.task)?.split('\n')[0].slice(0, 180) ?? 'Sub-agent';
  const t = typeof d.content_redacted === 'string' ? cleanText(d.content_redacted) : null;
  return t ? t.replace(/\s+/g, ' ').slice(0, 180) : 'Content withheld by capture policy';
}

export default function ActivityPage() {
  const { params, set, hrefPage } = useUrl();
  const { timezone, pageSize } = useSettings();
  const f = useFilters();
  const hourly = useHourly(f);
  const totals = useOverview(f);
  const limit = Math.min(500, Number(params.get('limit')) || pageSize);
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const kind = (FEED_KINDS as readonly string[]).includes(params.get('kind') ?? '') ? (params.get('kind') as (typeof FEED_KINDS)[number]) : 'all';
  const feed = useTimelinePage(f, limit, offset, kind === 'all' ? undefined : kind);

  const heat = useMemo(() => buildHeatmap(hourly.data ?? [], timezone, f.since ? f : undefined), [hourly.data, timezone, f]);
  const daily = useMemo(() => bucketActivity(hourly.data ?? [], timezone, 'day').points, [hourly.data, timezone]);

  const total = totals.data ? (kind === 'all' ? Object.values(totals.data).reduce((a, b) => a + b, 0) : totals.data[kind] ?? 0) : undefined;
  const rows = feed.data ?? [];
  const shownRows = rows;

  return (
    <>
      <PageHeader title="Activity" />
      <Async query={hourly} skeleton={<Skeleton height="6rem" label="Loading activity" />} isEmpty={(d) => !d.length} empty={<Panel><NoRecords /></Panel>}>
        {() => (
          <>
            <StatRow label="Activity summary">
              <Stat label="Prompts" value={fmtInt(heat.total)} sub={`over ${fmtInt(heat.spanDays)} calendar ${heat.spanDays === 1 ? 'day' : 'days'}`} />
              <Stat label="Active days" value={`${fmtInt(heat.activeDays)} of ${fmtInt(heat.spanDays)}`} sub={f.since ? 'calendar days in this window' : 'from the first prompt to the last'} />
              <Stat label="Busiest hour of day" value={heat.peakHour ? `${String(heat.peakHour.hour).padStart(2, '0')}:00` : '—'} sub={heat.peakHour ? `${fmtInt(heat.peakHour.count)} prompts in this hour, all days together` : undefined} />
              <Stat label="Busiest date" value={heat.busiestDay ? fmtDay(heat.busiestDay.iso, timezone) : '—'} sub={heat.busiestDay ? `${fmtInt(heat.busiestDay.count)} prompts that day` : undefined} />
            </StatRow>
            <div className="split">
              <Panel className="grow-2" title="Weekly rhythm" sub={heat.spanDays <= 7 ? 'Weekday by hour. Each row is a single date here.' : heat.spanDays < 14 ? `Weekday by hour over ${fmtInt(heat.spanDays)} days, so most rows are a single date.` : 'Weekday by hour, summed across the selected range'}>
                <ActivityHeatmap data={heat} />
              </Panel>
              <ChartPanel
                className="grow-1"
                title="Prompts per day"
                sub="In the display timezone"
                chart={<ColumnChart points={daily} tz={timezone} height={230} />}
                table={<table><thead><tr><th scope="col">Day</th><th scope="col" className="num">Prompts</th></tr></thead><tbody>{daily.map((d) => <tr key={d.key}><td>{fmtDay(d.iso, timezone)}</td><td className="num">{fmtInt(d.value)}</td></tr>)}</tbody></table>}
              />
            </div>
          </>
        )}
      </Async>

      <Panel
        title="Event feed"
        sub="Every record, newest first"
        action={
          <Segmented
            label="Record kind" value={kind}
            onChange={(v) => set({ kind: v === 'all' ? null : v }, { replace: true })}
            options={FEED_KINDS.map((k) => ({ value: k, label: k === 'all' ? 'All' : KIND[k].label + 's' }))}
          />
        }
      >
        <Async query={feed} skeleton={<SkeletonRows rows={10} label="Loading events" />} isEmpty={(d) => !d.length && kind === 'all'}>
          {() => (
            <>
              {shownRows.length ? (
                <ol className="feed">
                  {shownRows.map((r) => {
                    const K = KIND[r.kind];
                    const Icon = K?.icon ?? FileText;
                    const text = feedText(r);
                    return (
                      <li key={r.id} data-kind={r.kind}>
                        <span className="feed-icon" aria-hidden="true"><Icon size={13} /></span>
                        <span className="feed-kind">{K?.label ?? r.kind}</span>
                        <span className="feed-text">{r.thread_id ? <AppLink href={hrefPage('Threads', { id: r.thread_id })}>{text}</AppLink> : text}</span>
                        <span className="feed-side">
                          {(r.kind === 'tool' || r.kind === 'run' || r.kind === 'agent' || r.kind === 'model_turn') && typeof r.data?.status === 'string' && r.data.status !== 'completed' && <StatusBadge status={r.data.status} />}
                          <time dateTime={r.occurred_at} title={r.occurred_at}>{fmtDay(r.occurred_at, timezone)} {fmtClock(r.occurred_at, timezone)}</time>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              ) : <EmptyState compact title={`No ${KIND[kind].label.toLowerCase()} records in this view`}><p>Widen the time window or show all kinds.</p></EmptyState>}
              <div className="table-foot">
                <Pager
                  offset={offset} limit={limit} shown={rows.length}
                  total={isKnown(total) ? total : undefined} hasMore={rows.length === limit}
                  onPage={(o) => set({ offset: o || null })} onLimit={(n) => set({ limit: n, offset: null })}
                />
              </div>
            </>
          )}
        </Async>
      </Panel>
    </>
  );
}
