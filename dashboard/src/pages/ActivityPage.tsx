import { hasTurnUsage } from '../lib/entities';
import { Fragment, useMemo, useState } from 'react';
import { modelIcon, toolIcon } from '../lib/icons';
import { useModelSlots } from '../lib/data';
import { seriesColor } from '../lib/modelColors';
import { Bot, ChevronRight, Coins, FileText, Globe, MessageSquare, MessageSquareReply, Play, Wrench, type LucideIcon } from 'lucide-react';
import { ActivityHeatmap, ColumnChart } from '../components/charts';
import { Pager } from '../components/DataTable';
import { AppLink, Async, ChartPanel, EmptyState, NoRecords, PageHeader, Panel, plural, Segmented, Skeleton, SkeletonRows, Stat, StatRow, StatusBadge, NotYetPage } from '../components/ui';
import { bucketActivity, buildHeatmap } from '../lib/analytics';
import { useFilters, useHourly, useOverview, useTimelinePage } from '../lib/data';
import { isFuture } from '../lib/filters';
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

  if (isFuture(f)) return <NotYetPage title="Activity" />;

  return (
    <>
      <PageHeader title="Activity" action={<button type="button" className="link-btn feed-jump" onClick={() => document.getElementById('event-feed')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Event feed ↓</button>} />
      <Async query={hourly} skeleton={<Skeleton height="6rem" label="Loading activity" />} isEmpty={(d) => !d.length} empty={<Panel><NoRecords /></Panel>}>
        {() => (
          <>
            <StatRow label="Activity summary">
              <Stat label="Prompts" value={fmtInt(heat.total)} sub={`over ${fmtInt(heat.spanDays)} calendar ${heat.spanDays === 1 ? 'day' : 'days'}`} />
              <Stat label="Active days" value={`${fmtInt(heat.activeDays)} of ${fmtInt(heat.spanDays)}`} sub={f.since ? undefined : 'first prompt to last'} />
              <Stat label="Busiest hour, all days" value={heat.peakHour ? `${String(heat.peakHour.hour).padStart(2, '0')}:00` : '—'} sub={heat.peakHour ? `${fmtInt(heat.peakHour.count)} prompts` : undefined} />
              <Stat label="Busiest date" value={heat.busiestDay ? fmtDay(heat.busiestDay.iso, timezone) : '—'} sub={heat.busiestDay ? `${fmtInt(heat.busiestDay.count)} prompts` : undefined} />
            </StatRow>
            <div className="split">
              <Panel className="grow-2" title="Weekly rhythm" hint={heat.spanDays <= 7 ? 'Weekday by hour. Each row is a single date here.' : heat.spanDays < 14 ? `Weekday by hour over ${fmtInt(heat.spanDays)} days, so most rows are a single date.` : 'Weekday by hour, summed across the selected range'}>
                <ActivityHeatmap data={heat} />
              </Panel>
              <ChartPanel
                className="grow-1"
                title="Prompts per day"
                hint="In the display timezone."
                chart={<ColumnChart points={daily} tz={timezone} height={230} />}
                table={<table><thead><tr><th scope="col">Day</th><th scope="col" className="num">Prompts</th></tr></thead><tbody>{daily.map((d) => <tr key={d.key}><td>{fmtDay(d.iso, timezone)}</td><td className="num">{fmtInt(d.value)}</td></tr>)}</tbody></table>}
              />
            </div>
          </>
        )}
      </Async>

      <Panel
        id="event-feed"
        title="Event feed"
        hint="Newest first. In All, each run reads as one block in the order it happened: the prompt, its work folded into one line (open it for each record), then the answer."
        action={
          <div className="feed-filter"><Segmented
            label="Record kind" value={kind}
            onChange={(v) => set({ kind: v === 'all' ? null : v }, { replace: true })}
            options={FEED_KINDS.map((k) => ({ value: k, label: k === 'all' ? 'All' : KIND[k].label + 's' }))}
          /></div>
        }
      >
        <Async query={feed} skeleton={<SkeletonRows rows={10} label="Loading events" />} isEmpty={(d) => !d.length && kind === 'all'}>
          {() => (
            <>
              {shownRows.length ? (
                <ol className="feed">
                  {groupFeed(shownRows, kind === 'all').map((g, i, all) => {
                    const first = g.rows[0];
                    const day = fmtDay(first.occurred_at, timezone);
                    const newDay = i === 0 || fmtDay(all[i - 1].rows[0].occurred_at, timezone) !== day;
                    // A block whose prompt fell on another page says so, rather than looking like work with no cause.
                    const continued = kind === 'all' && g.start && first.kind !== 'prompt' && !!first.run_id;
                    return (
                      <Fragment key={first.id}>
                        {newDay && <li className="feed-day" aria-hidden="true">{day}</li>}
                        {continued && <li className="feed-continued">Its prompt is on the next page ↓</li>}
                        {g.rows.length === 1 ? <FeedRow r={first} run={g.run} tz={timezone} href={hrefPage} start={g.start} /> : <WorkGroup rows={g.rows} tz={timezone} href={hrefPage} />}
                      </Fragment>
                    );
                  })}
                </ol>
              ) : <EmptyState compact title={`No ${KIND[kind].label.toLowerCase()} records in this view`}><p>Widen the time window or show all kinds.</p></EmptyState>}
              <div className="table-foot">
                <Pager
                  offset={offset} limit={limit} shown={rows.length}
                  total={isKnown(total) ? total : undefined} hasMore={rows.length === limit}
                  onPage={(o) => set({ offset: o || null })} onLimit={(n) => set({ limit: n, offset: null })} label="Pages of records" unit="records"
                />
              </div>
            </>
          )}
        </Async>
      </Panel>
    </>
  );
}

type Href = (page: 'Threads', extra: Record<string, string>) => string;

/** In the all-kinds feed, the work one run did between messages folds into one line, so prompts and answers carry the story. */
function groupFeed(rows: Entity[], fold: boolean): { rows: Entity[]; run?: Entity; start?: boolean }[] {
  // In All, the records of one run read as one block in the order they happened: prompt, the work, then the answer.
  // Blocks stay newest first. Records with no run keep their own place.
  let ordered = rows;
  const starts = new Set<string>();
  if (fold) {
    const blocks = new Map<string, Entity[]>();
    for (const r of rows) { const k = r.run_id || r.id; (blocks.get(k) ?? blocks.set(k, []).get(k)!).push(r); }
    const rank = (r: Entity) => (r.kind === 'prompt' ? 0 : r.kind === 'answer' ? 2 : 1);
    ordered = [...blocks.values()].flatMap((b) => {
      const sorted = [...b].sort((x, y) => Date.parse(x.occurred_at) - Date.parse(y.occurred_at) || rank(x) - rank(y));
      starts.add(sorted[0].id);
      return sorted;
    });
  }
  const out: { rows: Entity[]; run?: Entity; start?: boolean }[] = [];
  const isWork = (r: Entity) => r.kind === 'tool' || r.kind === 'model_turn' || r.kind === 'run';
  for (const r of ordered) {
    const last = out[out.length - 1];
    // The run a prompt started shows as that prompt's model, not as a line of its own.
    if (fold && last && r.kind === 'run' && last.rows[0].kind === 'prompt' && !last.run && r.run_id && r.run_id === last.rows[0].run_id) { last.run = r; continue; }
    if (fold && last && !starts.has(r.id) && isWork(r) && isWork(last.rows[0]) && (r.run_id || r.thread_id) === (last.rows[0].run_id || last.rows[0].thread_id)) last.rows.push(r);
    else out.push({ rows: [r], start: fold ? starts.has(r.id) : true });
  }
  return out;
}

function FeedRow({ r, run, tz, href, nested, start = true }: { r: Entity; run?: Entity; tz: string; href: Href; nested?: boolean; start?: boolean }) {
  const runModel = run && typeof run.data?.requested_model === 'string' ? run.data.requested_model : null;
  const K = KIND[r.kind];
  const tool = r.kind === 'tool' ? String(r.data?.tool_name ?? '') : '';
  const model = r.kind === 'model_turn' || r.kind === 'run' ? (r.kind === 'run' ? (typeof r.data?.requested_model === 'string' ? r.data.requested_model : null) : toTurn(r).model) : null;
  const Icon = r.kind === 'tool' ? toolIcon(tool) : K?.icon ?? FileText;
  const text = feedText(r);
  const day = fmtDay(r.occurred_at, tz);
  return (
    <li data-kind={r.kind} className={nested ? 'feed-nested' : start ? undefined : 'feed-cont'}>
      <span className="feed-icon" aria-hidden="true">{model ? <ModelGlyph model={model} /> : <Icon size={13} />}</span>
      <span className="feed-kind">{K?.label ?? r.kind}</span>
      <span className="feed-text">{r.thread_id ? <AppLink href={href('Threads', { id: r.thread_id })}>{text}</AppLink> : text}</span>
      <span className="feed-side">
        {(r.kind === 'tool' || r.kind === 'run' || r.kind === 'agent' || r.kind === 'model_turn') && typeof r.data?.status === 'string' && r.data.status !== 'completed' && <StatusBadge status={r.data.status} />}
        {run && typeof run.data?.status === 'string' && run.data.status !== 'completed' && <StatusBadge status={run.data.status} />}
        {runModel && <span className="feed-run" title={`Run on ${runModel}`}><ModelGlyph model={runModel} /><span className="mono">{runModel}</span></span>}
        <time dateTime={r.occurred_at} title={`${day} ${fmtClock(r.occurred_at, tz)}`}><span className="sr-only">{day} </span>{fmtClock(r.occurred_at, tz)}</time>
      </span>
    </li>
  );
}

function WorkGroup({ rows, tz, href }: { rows: Entity[]; tz: string; href: Href }) {
  const [open, setOpen] = useState(false);
  const count = (k: string) => rows.filter((r) => r.kind === k).length;
  const failed = rows.filter((r) => r.data?.status === 'failed').length;
  const turns = rows.filter((r) => r.kind === 'model_turn').map(toTurn);
  const tokens = turns.reduce((a, t) => a + (t.total ?? 0), 0);
  // A turn without a total makes the sum a lower bound; turns with no total at all are a gap, not zero.
  const short = turns.some((t) => t.total === null);
  const models = [...new Set(rows.flatMap((r) => (r.kind === 'model_turn' ? [toTurn(r).model] : r.kind === 'run' && typeof r.data?.requested_model === 'string' ? [r.data.requested_model] : []).filter((m): m is string => !!m)))];
  const tools = [...new Set(rows.filter((r) => r.kind === 'tool').map((r) => String(r.data?.tool_name ?? 'tool')))];
  const parts = [count('model_turn') && plural(count('model_turn'), 'turn'), count('tool') && plural(count('tool'), 'tool call'), count('run') && plural(count('run'), 'run')].filter(Boolean).join(' · ');
  const byTime = [...rows].sort((x, y) => Date.parse(x.occurred_at) - Date.parse(y.occurred_at));
  const oldest = byTime[0];
  const newest = byTime[byTime.length - 1];
  return (
    <>
      <li data-group="work" className="feed-work feed-cont">
        <span className="feed-icon" aria-hidden="true">{models[0] ? <ModelGlyph model={models[0]} /> : <Wrench size={13} />}</span>
        <span className="feed-kind">Work</span>
        <span className="feed-text">
          <button type="button" className="feed-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <ChevronRight size={13} aria-hidden="true" className="feed-caret" />
            <span>{parts}</span>
            {turns.length > 0 && (tokens > 0
              ? <span className="feed-chip" title={short ? 'Some turns reported no total, so this is at least the sum' : undefined}>{short && '≥ '}{fmtCompact(tokens)} tokens</span>
              : <span className="unknown">Tokens not reported</span>)}
            <span className="feed-tools" aria-hidden="true">{tools.slice(0, 5).map((t) => { const I = toolIcon(t); return <I key={t} size={12} />; })}</span>
          </button>
        </span>
        <span className="feed-side">
          {failed > 0 && <StatusBadge status="failed" />}
          <time dateTime={newest.occurred_at}>{oldest.occurred_at !== newest.occurred_at ? `${fmtClock(oldest.occurred_at, tz)}–` : ''}{fmtClock(newest.occurred_at, tz)}</time>
        </span>
      </li>
      {open && rows.map((r) => <FeedRow key={r.id} r={r} tz={tz} href={href} nested />)}
    </>
  );
}

function ModelGlyph({ model }: { model: string }) {
  const slots = useModelSlots();
  const Icon = modelIcon(model);
  return <Icon size={13} aria-hidden="true" style={{ color: seriesColor(slots.get(model)) }} />;
}
