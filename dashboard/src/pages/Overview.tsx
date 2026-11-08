import { useDeferredValue, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUpRight, Download, GitCompareArrows, ZoomOut } from 'lucide-react';
import { ActivityHeatmap } from '../components/heatmap';
import { Counter } from '../components/motion';
import { TraceChart } from '../components/TraceChart';
import { AppLink, Async, ChartPanel, EmptyState, ErrorState, NotLoaded, PageHeader, Panel, plural, Segmented, SelectField, Skeleton, SkeletonRows, Unknown } from '../components/ui';
import { buildHeatmap, captureGaps, delta, summaryFromTurns, tokenSummary } from '../lib/analytics';
import { toCsv } from '../lib/api';
import { hasTurnUsage, turnMs } from '../lib/entities';
import { useAgents, useCollectorReadiness, useFilters, useHourly, useHourlyMany, useLiveTurns, useModels, useModelSlots, useOverview, useOverviews, useProjects, useQuota, useThreads, useToolAggregates, useToolAggregatesMany, useToolScan } from '../lib/data';
import { inTimeRange, previousWindow, windowTest, zoomInTrail, zoomOutPatch } from '../lib/filters';
import { fmtInt, isKnown, repairText } from '../lib/format';
import { modelProvider, OTHER_COLOR } from '../lib/modelColors';
import { buildTrace, effectiveResolution, idleGroup, METRICS, RESOLUTION_MS, turnGroupKey, type GroupBy, type LineTotal, type Metric, type Resolution } from '../lib/series';
import { useSettings } from '../lib/settings';
import { useWindowDraft, withDraft, zoomRange } from '../lib/timeWindow';
import { buildForest } from '../lib/tree';
import { useUrl } from '../lib/url';
import { dataOf, fromQueries, fromQuery, type Load } from '../lib/load';
import type { HourRow } from '../lib/types';
import { ChangeArrow, GapCell, GroupLine, signedPct, TokenTypes } from './overview/parts';
import { DelegationPanel, KeyTotals, RecentThreadsPanel, ToolsPanel, type ThreadActivity } from './overview/panels';
import { GROUPS, isGroup, isMetric, isRes, periodBefore, RES_OPTIONS, RES_WORDS } from './overview/trace';

/** The landing page: tokens over time by model, provider or project, with the totals and panels that follow the same window. */
export default function Overview() {
  const { hrefPage, params, set } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const draft = useWindowDraft();
  const live = useMemo(() => withDraft(f, draft), [f, draft]);

  const overview = useOverview(f);
  // Worked out afresh each minute, because a window reaching now keeps growing and what it compares with must keep the same length.
  const prevWindow = useMemo(() => previousWindow(f), [f]);
  const previous = useOverview({ ...f, ...prevWindow, range: undefined }, !!prevWindow);
  const hourly = useHourly(f);
  const firstEver = useHourly({ project: f.project, instance: f.instance, model: f.model });
  // What is known runs from the first record of all, whatever is filtered, to the last capture. Outside that nothing can be said, inside it a zero is a zero.
  const allHours = useHourly({ instance: f.instance });
  const readiness = useCollectorReadiness();
  const slots = useModelSlots();
  // Every turn in scope, unfiltered by time, so the headline, list and chart agree and follow the slider without a request per day moved.
  // Older history waits until the panels on screen have their data, unless the window reaches back past the recent turns.
  // A one-way latch: held, then released for good once the window needs older history, the panels on screen have their
  // data, or the recent read failed. It never closes again.
  const [historyGo, setHistoryGo] = useState(false);
  const { all: wholeTurns, recent: recentTurns, rows: turnRows, coversFrom, coverage: turnCoverage } = useLiveTurns(f, true, !historyGo);
  // Heavy reads slow each other down on the service, so what the chart needs goes first and the rest follows.
  const chartReady = !!(recentTurns.data || wholeTurns.data) || recentTurns.isError;
  const models = useModels(f, chartReady);
  const threads = useThreads(f, chartReady);
  const agents = useAgents(f, chartReady);
  const needsHistory = !live.since || Date.parse(live.since) < coversFrom;
  const panelsIn = (threads.isFetched || threads.isError) && (agents.isFetched || agents.isError);
  useEffect(() => { if (!historyGo && (needsHistory || panelsIn || recentTurns.isError)) setHistoryGo(true); }, [historyGo, needsHistory, panelsIn, recentTurns.isError]);
  const projects = useProjects();
  const toolAggregates = useToolAggregates(f, chartReady);
  const tools = useToolScan(f, 1000, toolAggregates.isError);
  const quota = useQuota('quota/current', chartReady);
  const [hovered, setFocus] = useState<string | null>(null);
  const by: GroupBy = isGroup(params.get('by')) ? (params.get('by') as GroupBy) : 'model';
  const metric: Metric = isMetric(params.get('metric')) ? (params.get('metric') as Metric) : 'total';
  const resChoice: Resolution | 'auto' = isRes(params.get('res')) ? (params.get('res') as Resolution) : 'auto';
  const view = params.get('view') === 'stacked' || params.get('view') === 'cumulative' ? (params.get('view') as 'stacked' | 'cumulative') : 'lines';
  const compare = params.get('compare') === '1';
  const metricInfo = METRICS.find((m) => m.key === metric)!;
  // Rows are the filter. Any number can be chosen, and the whole page follows them.
  const picksParam = params.get('pick');
  const picks = useMemo(() => new Set((picksParam ?? '').split(',').filter(Boolean)), [picksParam]);
  const showUnnamed = params.get('nr') === '1';
  const unscopable = picks.has('not-recorded');
  const scopes = useMemo<typeof f[]>(() => {
    const chosen = [...picks].filter((k) => k !== 'not-recorded');
    if (by === 'project') return chosen.map((project) => ({ ...f, project }));
    // The service works out each record's provider the way the rows do, so a provider's counts include turns that name no model.
    if (by === 'provider') return chosen.map((provider) => ({ ...f, provider }));
    return chosen.map((model) => ({ ...f, model }));
  }, [picks, by, f]);
  const previousScopes = useMemo(() => (prevWindow ? scopes.map((s) => ({ ...s, ...prevWindow, range: undefined })) : []), [scopes, prevWindow]);
  const pickedCounts = useOverviews(scopes);
  const pickedPrevious = useOverviews(previousScopes);
  const pickedHourly = useHourlyMany(scopes);
  const pickedTools = useToolAggregatesMany(scopes);
  const sumCounts = (list: Record<string, number>[]) => {
    const out: Record<string, number> = {};
    for (const counts of list) for (const [k, v] of Object.entries(counts)) out[k] = (out[k] ?? 0) + v;
    return out;
  };

  // Picked rows count only once every picked row has loaded; one failure is said as such, never summed as 0.
  const countsLoad: Load<Record<string, number>> = picks.size ? fromQueries(pickedCounts, sumCounts) : fromQuery(overview);
  const c = dataOf(countsLoad) ?? {};
  const prev = picks.size ? (previousScopes.length ? dataOf(fromQueries(pickedPrevious, sumCounts)) : undefined) : previous.data;
  // A comparison needs capture to cover the whole previous window; otherwise it would only measure when capture started.
  const captureStart = firstEver.data?.[0]?.hour;
  const comparable = !!prevWindow && !!prev && !!captureStart && Date.parse(captureStart) <= Date.parse(prevWindow.since);

  const threadRows = threads.data?.rows;
  const agentRows = agents.data?.rows;
  const childCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agentRows ?? []) m.set(a.thread_id, (m.get(a.thread_id) ?? 0) + 1);
    return m;
  }, [agentRows]);

  const forest = useMemo(() => (threadRows && agentRows ? buildForest(threadRows, agentRows) : null), [threadRows, agentRows]);
  const modelRows = useMemo(() => (models.data ?? []).filter((m) => !f.model || m.model === f.model), [models.data, f.model]);
  const summary = useMemo(() => tokenSummary(modelRows), [modelRows]);

  const projectName = useMemo(() => {
    const names = new Map((projects.data ?? []).map((p) => [p.source_id, repairText(String(p.data?.name ?? p.source_id))]));
    return (id: string) => names.get(id) ?? null;
  }, [projects.data]);

  const scoped = useMemo(() => turnRows.filter((t) => !f.model || t.model === f.model), [turnRows, f.model]);
  const firstTurn = useMemo(() => scoped.reduce((m, t) => Math.min(m, turnMs(t)), Infinity), [scoped]);
  // The recent turns are enough for a recent window. Anything earlier waits for the whole history, which is on its way in the background.
  const covered = !!wholeTurns.data || (!!live.since && Date.parse(live.since) >= coversFrom);
  // With the recent read failed, the whole history is the only way left to cover the window.
  const allTurns = wholeTurns.data || !covered || recentTurns.isError ? wholeTurns : recentTurns;
  const turnsFailed = turnCoverage(live.since ? Date.parse(live.since) : -Infinity) === 'failed';
  // The service's model totals answer only "all tokens": for the headline in any grouping, and for the list grouped by model.
  const headlineFallback = metric === 'total';
  const listFallback = metric === 'total' && by === 'model';
  const reach = live.until ? Date.parse(live.until) : Math.ceil(Date.now() / 60_000) * 60_000;
  // Capture normally runs every few minutes, so a long silence means nothing after it can be known yet.
  const lastCapture = Date.parse(readiness.data?.collector?.last_successful_sync_at ?? '');
  const captureStale = Number.isFinite(lastCapture) && Date.now() - lastCapture > 15 * 60_000;
  const until = captureStale ? Math.min(reach, lastCapture) : reach;
  const since = live.since ? Date.parse(live.since) : Number.isFinite(firstTurn) ? firstTurn : until - 86_400_000;
  // Before the first record nothing is known, which is not the same as nothing having run. The axis starts at the record, and a window wholly before it says so.
  // Anything recorded counts as captured: prompts, and tokens from turns or session logs.
  const recordTimes = useMemo(() => {
    const times = (allHours.data ?? []).map((h) => h.hour);
    if (!f.project && wholeTurns.data) for (const t of wholeTurns.data.rows) times.push(t.occurred_at);
    return times;
  }, [allHours.data, wholeTurns.data, f.project]);
  const firstRecord = useMemo(() => recordTimes.reduce((m, t) => Math.min(m, Date.parse(t)), Infinity), [recordTimes]);
  const historyKnown = Number.isFinite(firstRecord);
  const beforeHistory = historyKnown && until < firstRecord;
  const clipped = historyKnown && !beforeHistory && since < firstRecord;
  const historyDate = historyKnown ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(firstRecord)) : '';
  const captureTime = captureStale ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(lastCapture)) : '';
  // A long silence inside the history means nothing was captured then, so it is not read as a quiet time either.
  const gaps = useMemo(() => captureGaps(recordTimes), [recordTimes]);
  const inGap = gaps.find(([a, b]) => since >= a && until <= b);
  const dayText = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
  // A window that starts later than now has not happened, and one after the last capture has not been read yet.
  const unknownWindow = live.since && Date.parse(live.since) > Date.now() ? { title: 'Not yet', text: 'This window starts later than now, so nothing is known about it yet.' }
    : captureStale && reach > lastCapture && since >= lastCapture ? { title: 'Not captured yet', text: `The last capture was on ${captureTime}. Nothing since then is known yet.` }
      : beforeHistory ? { title: 'Before history', text: `Token usage here starts on ${historyDate}. Anything earlier was not captured, so this is unknown, not zero.` }
        : inGap ? { title: 'Not captured', text: `Nothing was captured from ${dayText(inGap[0])} to ${dayText(inGap[1])}, so this is unknown, not zero.` }
          : null;
  const plotSince = clipped ? firstRecord : since;
  const span = Math.max(1, until - plotSince);
  // A bucket much longer than the window would draw one point that reads as a whole week or day, so those are switched off too.
  const tooCoarse = (r: Resolution) => RESOLUTION_MS[r] >= span * 0.5;
  // A bucket longer than the window falls back to the automatic choice, which always fits.
  const res = (() => { const r = effectiveResolution(resChoice, span); return tooCoarse(r) ? effectiveResolution('auto', span) : r; })();
  const resOptions = RES_OPTIONS.map((o) => (o.value === 'auto' ? o : effectiveResolution(o.value, span) !== o.value ? { ...o, disabled: true, title: 'Too fine for this window' } : tooCoarse(o.value) ? { ...o, disabled: true, title: 'Too long for this window' } : o));
  // The list always ranks every group. The chart and the headline follow the rows chosen, and turns that name no model stay off the chart until asked for.
  const chartTurns = useMemo(
    () => scoped.filter((t) => { const key = turnGroupKey(t, by); return picks.size ? picks.has(key) : showUnnamed || key !== 'not-recorded'; }),
    [scoped, by, picks, showUnnamed],
  );
  const listTrace = useMemo(
    () => buildTrace({ turns: scoped, by, metric, res, tz: timezone, since: plotSince, until, modelColors: slots, projectName, totalsOnly: true, limit: 500 }),
    [scoped, by, metric, res, timezone, plotSince, until, slots, projectName],
  );
  const lineLimit = picks.size ? 64 : by === 'project' || span > 31 * 86_400_000 ? 8 : 64;
  const trace = useMemo(
    () => buildTrace({ turns: chartTurns, by, metric, res, tz: timezone, since: plotSince, until, modelColors: slots, projectName, limit: lineLimit, cumulative: view === 'cumulative' }),
    [chartTurns, by, metric, res, timezone, plotSince, until, slots, projectName, lineLimit, view],
  );
  const head = picks.size ? trace : listTrace;
  // Turns that name no model, while they are off the chart, still belong in a reading of what ran, so a pinned bucket adds up to the period it opens.
  const asideTrace = useMemo(() => {
    if (picks.size || showUnnamed) return null;
    const unnamedTurns = scoped.filter((t) => turnGroupKey(t, by) === 'not-recorded');
    if (!unnamedTurns.length) return null;
    const t = buildTrace({ turns: unnamedTurns, by, metric, res, tz: timezone, since: plotSince, until, modelColors: slots, projectName, limit: 1, cumulative: view === 'cumulative' });
    if (!t.series.length || t.rows.length !== trace.rows.length) return null;
    const key = t.series[0].key;
    return { label: 'Not recorded (off chart)', values: t.rows.map((r) => Number(r[key] ?? 0)), lower: new Set([...t.partials.keys()]) };
  }, [picks.size, showUnnamed, scoped, by, metric, res, timezone, plotSince, until, slots, projectName, view, trace.rows.length]);
  const blackout = useMemo(() => new Set(trace.rows.flatMap((r, i) => (gaps.some(([a, b]) => r.t >= a && r.end <= b) ? [i] : []))), [trace.rows, gaps]);
  const missingRows = useMemo(() => {
    if (!blackout.size) return trace.gaps;
    const merged = new Map(trace.gaps);
    for (const i of blackout) merged.set(i, new Set(trace.series.map((s) => s.key)));
    return merged;
  }, [trace.gaps, trace.series, blackout]);

  // The same length of time just before this window, for the delta and the dashed line.
  const prevLive = useMemo(() => previousWindow(live), [live]);
  const previousTrace = useMemo(() => {
    if (!prevLive) return null;
    const pSince = Date.parse(prevLive.since);
    const pUntil = Date.parse(prevLive.until);
    if (!Number.isFinite(firstTurn) || pSince < firstTurn || (!wholeTurns.data && pSince < coversFrom)) return null;
    return buildTrace({ turns: chartTurns, by, metric, res, tz: timezone, since: pSince, until: pUntil, modelColors: slots, projectName, cumulative: view === 'cumulative', limit: 500 });
  }, [prevLive, firstTurn, wholeTurns.data, coversFrom, chartTurns, by, metric, res, timezone, slots, projectName, view]);
  const previousHead = useMemo(() => {
    if (!previousTrace || !prevLive || picks.size) return previousTrace;
    return buildTrace({ turns: scoped, by, metric, res, tz: timezone, since: Date.parse(prevLive.since), until: Date.parse(prevLive.until), modelColors: slots, projectName, totalsOnly: true, limit: 500 });
  }, [previousTrace, prevLive, picks.size, scoped, by, metric, res, timezone, slots, projectName]);
  // Focus only holds while its line is on the chart, so nothing can dim everything with no way back.
  const focus = hovered && trace.series.some((s) => s.key === hovered) ? hovered : null;
  // With a group in focus, compare that group with itself. Otherwise compare totals, and draw this period's total so like meets like.
  // Points pair up by time, not position, so a clock change or an uneven edge never shifts the line or invents a zero.
  const offset = prevLive ? since - Date.parse(prevLive.since) : 0;
  const wholeBefore = useMemo(() => (compare && previousTrace ? periodBefore(trace.rows, previousTrace, offset, null) : null), [compare, previousTrace, trace.rows, offset]);
  const focusKey = focus && focus !== 'Other' ? focus : null;
  const before = useMemo(() => (focusKey && previousTrace && wholeBefore ? periodBefore(trace.rows, previousTrace, offset, focusKey) : wholeBefore), [focusKey, previousTrace, trace.rows, offset, wholeBefore]);
  // A bucket where everything was silent has no total to draw, so the line breaks there like every other line.
  const wholeTotal = useMemo(() => trace.rows.map((r, i) => (trace.unreported.has(i) && trace.series.every((x) => !r[x.key]) ? null : trace.series.reduce((s, x) => s + Number(r[x.key] ?? 0), 0))), [trace.rows, trace.series, trace.unreported]);
  const totalLine = before && view !== 'stacked' && !focusKey ? wholeTotal : null;
  // Focusing a line changes which lines show, never the scale they are read against.
  const scaleTop = useMemo(() => (wholeBefore ? Math.max(0, ...wholeBefore.values.map((v) => v ?? 0), ...wholeTotal.map((v) => v ?? 0)) : 0), [wholeBefore, wholeTotal]);
  // A group with no line of its own still needs saying when it ran and reported nothing.
  const offChart = useMemo(() => {
    const drawnLabels = new Set(trace.series.map((s) => s.label));
    return new Map([...trace.unreported].map(([i, names]) => [i, names.filter((n) => !drawnLabels.has(n))]));
  }, [trace.unreported, trace.series]);
  const hasOffChart = useMemo(() => [...offChart.values()].some((v) => v.length), [offChart]);

  const windowed = !!(f.since || f.until || f.range);
  // One source for the headline, list and chart, so they can never disagree. The service's totals are used only when its turns are unavailable or cut short.
  const turnsLoading = allTurns.isPending;
  const fromTurns = !!allTurns.data?.complete && scoped.length > 0;
  const empty = fromTurns ? head.records === 0 : allTurns.isSuccess && !summary.total && windowed;
  // The turns covering the window could not be read, and the model totals cannot stand in (another measure, or they failed too),
  // so the headline is not known. Without this a partial sum of the recent days would read as the window's exact total.
  const loadFailed = turnsFailed && (!headlineFallback || (!models.data && (models.isError || !chartReady)));
  const total = unknownWindow || loadFailed ? null : empty ? 0 : fromTurns || metric !== 'total' ? (turnsLoading ? null : head.total) : summary.total;
  // A percentage needs both sides to be nearly whole, or it mostly measures what went unreported.
  const wellReported = (t: { reported: number; turns: number }) => metric === 'turns' || t.turns === 0 || t.reported / t.turns >= 0.9;
  const change = previousHead && isKnown(head.total) && isKnown(previousHead.total) && wellReported(head) && wellReported(previousHead) ? delta(head.total, previousHead.total) : null;
  const lines = useMemo<LineTotal[]>(() => {
    if (fromTurns || (turnsLoading && !listFallback)) {
      // Every model and provider stays listed, ranked by use, so one that was quiet in this window can still be chosen.
      const seen = new Set(listTrace.lines.map((l) => l.key));
      const known = f.model || by === 'project' ? [] : by === 'model' ? [...slots.keys()] : [...new Set([...slots.keys()].flatMap((m) => modelProvider(m) ?? []))];
      const idle = known.filter((k) => !seen.has(k)).flatMap((k) => { const info = idleGroup(by, k, slots); return info ? [{ key: k, value: 0, turns: 0, reported: 0, partial: false, info }] : []; });
      return [...listTrace.lines, ...idle];
    }
    // Model totals are the wrong numbers for another measure or grouping, so with the turns failed the list shows the error instead.
    if (turnsFailed && !listFallback) return [];
    // An older service has no turns to sum, but its model totals can still fill the list.
    return modelRows.filter((m) => (m.total_tokens ?? 0) > 0 || (m.observed_provider_turns ?? 0) > 0).map((m) => ({
      key: m.model ?? 'not-recorded', value: m.total_tokens ?? 0, turns: m.observed_provider_turns ?? 0, reported: m.turns_with_usage ?? m.observed_provider_turns ?? 0, partial: !!m.turns_with_usage,
      info: { key: m.model ?? 'not-recorded', label: m.model ?? 'Not recorded', color: m.model ? slots.get(m.model) ?? OTHER_COLOR : OTHER_COLOR, model: m.model ?? null, provider: null, dash: !m.model },
    })).sort((a, b) => b.value - a.value);
  }, [fromTurns, turnsLoading, turnsFailed, listFallback, metric, by, f.model, listTrace.lines, modelRows, slots]);
  // Some turns reported and some did not, so the sum is at least this much.
  const lowerBound = isKnown(total) && total > 0 && metric !== 'turns' && (fromTurns ? head.reported < head.turns : !!summary.turns && (summary.withUsage ?? 0) < summary.turns);
  // A model can report some fields but no complete total, and that is said plainly.
  const whyMissing = (partial: boolean) => (partial ? `Reported token fields, but ${metric === 'total' ? 'no complete total' : `no ${metricInfo.label.toLowerCase()}`}. Pick another measure to see them.` : 'Reported no token usage.');
  const unnamed = lines.find((l) => l.key === 'not-recorded' && l.value > 0);
  const allLines = useMemo(() => lines.filter((l) => l.key !== 'not-recorded' || l.value > 0 || l.turns > 0), [lines]);
  // Groups with no turns in this window stay listed so they can be chosen, but folded under one button so the ones that ran stand out.
  const [showIdle, setShowIdle] = useState(false);
  const windowUnknown = !!unknownWindow;
  const idle = useMemo(() => (windowUnknown ? [] : allLines.filter((l) => l.turns === 0 && l.value === 0 && !picks.has(l.key))), [allLines, windowUnknown, picks]);
  const shownLines = useMemo(() => (showIdle || idle.length < 2 ? allLines : allLines.filter((l) => !idle.includes(l))), [allLines, idle, showIdle]);
  // One tab stop for the whole list. The arrow keys move between rows.
  const [rove, setRove] = useState(0);
  const roveTo = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.model-line')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : keys[e.key] !== undefined ? Math.max(0, Math.min(buttons.length - 1, at + keys[e.key])) : null;
    if (next === null) return;
    e.preventDefault();
    setRove(next);
    buttons[next].focus();
  };
  const topValue = Math.max(1, ...shownLines.map((l) => l.value));
  const togglePick = (key: string) => {
    const next = new Set(picks);
    if (next.has(key)) next.delete(key); else next.add(key);
    set({ pick: next.size ? [...next].join(',') : null });
  };
  const drawn = useMemo(() => new Set(trace.series.map((s) => s.key)), [trace.series]);
  // A row can vanish under the pointer when the data moves, and then it never reports the pointer leaving.
  useEffect(() => {
    if (hovered && !shownLines.some((l) => (drawn.has(l.key) ? l.key : 'Other') === hovered)) setFocus(null);
  }, [hovered, shownLines, drawn]);
  const zoomTo = (from: number, to: number) => {
    const zoom = zoomRange(from, to);
    // Opening a bar has to show something finer, so a fixed resolution gives way to the automatic one.
    set({ since: new Date(from).toISOString(), until: new Date(to - 1).toISOString(), zs: new Date(zoom.from).toISOString(), ze: new Date(zoom.to).toISOString(), range: null, res: null, track: null, rp: null, offset: null, up: zoomInTrail(params) });
  };
  const exportCsv = () => {
    // A group that ran but reported nothing is left blank, because that is not a zero.
    const csv = toCsv(['Time', ...trace.series.map((x) => x.label), 'Ran but reported nothing', 'Lower bound, some turns missing'], trace.rows.map((r, i) => [new Date(r.t).toISOString(), ...trace.series.map((x) => (missingRows.get(i)?.has(x.key) ? null : Number(r[x.key] ?? 0))), trace.unreported.get(i)?.join('; ') ?? null, [...(trace.partials.get(i) ?? [])].map((k) => trace.series.find((x) => x.key === k)?.label ?? k).join('; ') || null]));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `runtrace-${metric}-by-${by}-${res}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // The panels below the chart follow the window once a drag pauses, so moving the slider redraws the chart and headline first.
  const settled = useDeferredValue(live);
  // What each thread did inside the window. A thread started last week still counts if it ran today.
  const activity = useMemo(() => {
    const m = new Map<string, ThreadActivity>();
    const inLive = windowTest(settled);
    for (const t of picks.size ? chartTurns : scoped) {
      if (!inLive(turnMs(t))) continue;
      const e = m.get(t.thread_id) ?? { last: t.occurred_at, turns: 0, tokens: null, missing: false };
      e.turns += 1;
      if (t.occurred_at > e.last) e.last = t.occurred_at;
      if (t.total !== null) e.tokens = (e.tokens ?? 0) + t.total; else e.missing = true;
      m.set(t.thread_id, e);
    }
    return m;
  }, [scoped, chartTurns, picks.size, settled]);
  const inWindow = useMemo(
    () => (threadRows ?? []).filter((t) => activity.has(t.source_id) || (!picks.size && inTimeRange(t.occurred_at, settled) && (!f.model || t.model === f.model))),
    [threadRows, activity, settled, f.model, picks.size],
  );
  const mainThreads = useMemo(() => inWindow.filter((t) => t.type !== 'child').length, [inWindow]);

  const hourlyLoad: Load<HourRow[]> = picks.size ? pickedHourly : fromQuery(hourly);
  const heat = useMemo(() => buildHeatmap(dataOf(hourlyLoad) ?? [], timezone), [hourlyLoad, timezone]);
  // The tokens by type follow the rows chosen too.
  // The parts are taken from turns that reported a total, so they add up to the headline. Turns with parts but no total are counted and named, not mixed in.
  const { typeSummary, partsOnly } = useMemo(() => {
    if (!fromTurns) return { typeSummary: summary, partsOnly: 0 };
    const inLive = windowTest(settled);
    const here = (picks.size ? chartTurns : scoped).filter((t) => inLive(turnMs(t)));
    const all = summaryFromTurns(here);
    const parts = summaryFromTurns(here.filter((t) => t.total !== null));
    return { typeSummary: { ...parts, turns: all.turns, withUsage: all.withUsage }, partsOnly: here.filter((t) => t.total === null && hasTurnUsage(t)).length };
  }, [fromTurns, picks.size, chartTurns, scoped, settled, summary]);
  const hasTokens = summary.total !== null;
  const callsKnown = (models.data ?? []).some((m) => isKnown(m.calls));
  const resolvedKnown = useMemo(() => turnRows.some((t) => t.resolved !== null), [turnRows]);
  const quotaKnown = !!quota.data?.data?.length;
  // A quiet window is not an empty database, so the page stays and reads as zero.
  const noData = overview.isSuccess && !Object.values(overview.data ?? {}).some((v) => v > 0) && firstEver.isSuccess && !firstEver.data?.length && !picks.size;
  const replayKey = `${f.range ?? ''}|${f.project ?? ''}|${f.model ?? ''}|${by}|${metric}|${view}|${params.get('zs') ?? ''}|${picksParam ?? ''}`;

  return (
    <>
      <PageHeader title="Overview" quiet />

      {overview.isError && <Panel><ErrorState error={overview.error} onRetry={() => overview.refetch()} /></Panel>}

      {!noData && (
        <section className="hero" aria-label="Tokens by group">
          <div className="hero-side">
            <div className="tokens-hero">
              <strong title={isKnown(total) ? `${lowerBound ? 'At least ' : ''}${fmtInt(total)} ${metricInfo.unit}` : undefined}>
                {(models.isPending && !fromTurns) || (turnsLoading && metric !== 'total') ? <span className="skeleton hero-skeleton" role="status" aria-label="Loading tokens" />
                  : isKnown(total) ? <>{lowerBound && <span className="lower-bound"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}<Counter value={total} ms={draft ? 160 : 1100} /></>
                    : unknownWindow ? <Unknown label={unknownWindow.title} why={unknownWindow.text} />
                    : loadFailed ? <NotLoaded />
                    : <Unknown label={metric === 'total' ? 'No complete total' : 'Not reported'} why="Nothing in this view reported this measure. Another measure may show what was reported." />}
              </strong>
              <span>
                {metricInfo.unit}{threads.data && !turnsLoading && (mainThreads > 0 || !unknownWindow) ? ` · ${plural(mainThreads, 'main thread')}` : ''}
                {change === null && !draft && previousHead && isKnown(head.total) && isKnown(previousHead.total) && (
                  <em className="hero-nocompare" title="Not compared: fewer than 9 in 10 turns reported tokens in this period or the one before, so a percentage would mostly measure what went unreported.">not compared</em>
                )}
                {change !== null && !draft && (
                  <em className="hero-delta" title="Compared with the same length of time just before">
                    <ChangeArrow change={change} />{signedPct(change)}
                    <span className="sr-only"> compared with the previous period</span>
                  </em>
                )}
              </span>
            </div>
            <Segmented label="Group by" value={by} options={GROUPS} onChange={(v) => { setFocus(null); set({ by: v === 'model' ? null : v, pick: null }); }} />
            <Async<unknown> query={fromTurns || (turnsFailed && !listFallback) ? allTurns : models} skeleton={<SkeletonRows rows={4} label="Loading groups" />} compact empty={<></>} isEmpty={() => !lines.length && !turnsLoading}>
              {() => (
                <>
                  <ul className="model-lines" onKeyDown={roveTo} aria-label={`${GROUPS.find((g) => g.value === by)!.label}. Arrow keys move between rows.`} data-focus={focus ? 'true' : undefined} data-picking={picks.size ? 'true' : undefined}>
                    {shownLines.map((l, i) => <GroupLine key={l.key} tabIndex={i === Math.min(rove, shownLines.length - 1) ? 0 : -1} onRove={() => setRove(i)} offChart={l.key === 'not-recorded' && !showUnnamed && !picks.has('not-recorded')} line={l} total={listTrace.total ?? total} top={topValue} by={by} unit={metricInfo.unit} draft={!!draft} focused={focus === (drawn.has(l.key) ? l.key : 'Other')} seriesKey={l.key === 'not-recorded' && !drawn.has(l.key) ? '' : drawn.has(l.key) ? l.key : 'Other'} onFocus={setFocus} selected={picks.has(l.key)} onToggle={togglePick} why={whyMissing(l.partial)} unknown={unknownWindow} />)}
                  </ul>
                  {idle.length >= 2 && (
                    <button type="button" className="idle-toggle" aria-expanded={showIdle} onClick={() => setShowIdle((v) => !v)}>
                      {showIdle ? `Fold ${idle.length} with no turns here` : `${idle.length} more with no turns here`}
                    </button>
                  )}
                  {unnamed && !picks.size && (
                    <button type="button" className="usage-chip unnamed-toggle" aria-pressed={showUnnamed} onClick={() => set({ nr: showUnnamed ? null : 1 })} title={showUnnamed ? 'Take turns that name no model off the chart' : 'Draw turns that name no model on the chart'}>
                      Not recorded on chart
                    </button>
                  )}
                </>
              )}
            </Async>
          </div>

          <ChartPanel
            className="hero-chart"
            title={turnsLoading ? metricInfo.label : view === 'cumulative' ? `Running ${metricInfo.label.toLowerCase()}` : `${metricInfo.label} per ${RES_WORDS[res]}`}
            action={
              <div className="chart-controls">
                <SelectField label="Measure" hideLabel value={metric} onChange={(v) => set({ metric: v === 'total' ? null : v })} options={METRICS.map((m) => ({ value: m.key, label: m.label }))} />
                <Segmented label="Resolution" value={resChoice} options={resOptions} onChange={(v) => set({ res: v === 'auto' ? null : v })} />
                {resChoice !== 'auto' && res !== resChoice && <span className="fine res-note" title={tooCoarse(resChoice) ? `${resChoice} is too long for this window` : `${resChoice} would draw too many points for this window`}>per {RES_WORDS[res]}</span>}
                <Segmented label="Chart style" value={view} options={[{ value: 'lines', label: 'Lines' }, { value: 'stacked', label: 'Stacked' }, { value: 'cumulative', label: 'Running' }]} onChange={(v) => set({ view: v === 'lines' ? null : v })} />
                <button type="button" className="icon-btn" disabled={!trace.rows.length || !!unknownWindow} onClick={exportCsv} aria-label="Download this chart as CSV" title="Download CSV"><Download size={15} aria-hidden="true" /></button>
                <button type="button" className={compare ? 'icon-btn is-on' : 'icon-btn'} aria-pressed={compare} disabled={!previousTrace && !compare} onClick={() => set({ compare: compare ? null : 1 })} aria-label="Compare with the period before" title={previousTrace ? 'Compare with the period before' : 'Choose a window with history before it to compare'}><GitCompareArrows size={15} aria-hidden="true" /></button>
                {!!f.since && <button type="button" className="icon-btn" onClick={() => set(zoomOutPatch(params))} aria-label="Zoom out one step" title={params.get('up') ? 'Back to the window this came from (z)' : 'Zoom out one step (z)'}><ZoomOut size={15} aria-hidden="true" /></button>}
              </div>
            }
            chart={
              unknownWindow ? <div className="before-history"><b>{unknownWindow.title}</b><span>{unknownWindow.text}</span></div>
                : loadFailed ? <ErrorState error={allTurns.error} onRetry={() => { allTurns.refetch(); models.refetch(); }} compact />
                : !isKnown(total) && !empty && !turnsLoading && !models.isPending && metric === 'total' ? <p className="fine">No complete token totals here. Another measure may show what was reported.</p>
                : <Async query={allTurns} skeleton={<Skeleton height="520px" label="Loading tokens" />} isEmpty={() => !trace.rows.length} compact>{() => (
                  <div className="trace-wrap">
                    <TraceChart rows={trace.rows} series={trace.series} focus={focus} replay={replayKey} height={520} stacked={view === 'stacked'} ghost={before?.values ?? null} ghostSilent={before?.silent} ghostLower={before?.lower} scaleTop={scaleTop} windowStart={plotSince} windowEnd={live.until ? until : undefined} ghostLabel="Period before" unit={metricInfo.unit} onZoom={zoomTo} aside={asideTrace} gaps={trace.unreported} missingAt={missingRows} blackout={blackout} partialAt={trace.partials} totalLine={totalLine} whole={metric === 'turns'} />
                    {empty && <p className="trace-empty">Nothing ran in this window</p>}
                    {clipped && <p className="trace-note">History here starts on {historyDate}</p>}
                    {captureStale && reach > lastCapture && <p className="trace-note">Captured up to {captureTime}</p>}
                  </div>
                )}</Async>
            }
            table={
              unknownWindow ? <div className="before-history"><b>{unknownWindow.title}</b><span>{unknownWindow.text}</span></div> : <table>
                <thead><tr><th scope="col">Time</th>{trace.series.map((s) => <th key={s.key} scope="col" className="num">{s.label}</th>)}{hasOffChart && <th scope="col">Also ran</th>}</tr></thead>
                <tbody>{trace.rows.map((d, i) => (
                  <tr key={d.t}>
                    <td>{d.end - d.t >= 3_600_000 ? <button type="button" className="link-btn" onClick={() => zoomTo(d.t, d.end)} title="Open this period">{d.label}</button> : d.label}</td>
                    {trace.series.map((s) => <td key={s.key} className="num">{blackout.has(i) ? <Unknown label="Not captured" why="Nothing was captured here." /> : trace.gaps.get(i)?.has(s.key) ? <Unknown label="Not reported" why={`${s.label} ran here but reported no ${metricInfo.unit}.`} /> : `${trace.partials.get(i)?.has(s.key) ? '≥ ' : ''}${fmtInt(Number(d[s.key] ?? 0))}`}</td>)}
                    {hasOffChart && <td>{offChart.get(i)?.length ? <Unknown label={offChart.get(i)!.join(', ')} why={`These ran here but reported no ${metricInfo.unit}.`} /> : null}</td>}
                  </tr>
                ))}</tbody>
              </table>
            }
          />
        </section>
      )}

      {(!overview.isError || picks.size > 0) && (
        <KeyTotals counts={countsLoad} previous={prev} comparable={comparable} windowed={!!(f.since || f.until)} turnsSeen={turnRows.length > 0} unscopable={unscopable} unknown={unknownWindow} stale={!!draft || overview.isPlaceholderData} />
      )}

      {unknownWindow ? (
        // Nothing below can be said about a window that is not known, so it says why once instead of reading as empty.
        <Panel><EmptyState title={unknownWindow.title}><p>{unknownWindow.text}</p></EmptyState></Panel>
      ) : noData ? (
        <Panel>
          <EmptyState title="No imported history in this view">
            <p>Clear the filters, or import completed T3 history with <code>runtrace import --all</code>.</p>
          </EmptyState>
        </Panel>
      ) : (
        <>
          <div className="split split-even">
            <Panel title="Tokens by type">
              <Async<unknown> query={fromTurns ? allTurns : models} skeleton={<SkeletonRows rows={2} label="Loading token types" />} compact>{() => <TokenTypes s={typeSummary} partsOnly={partsOnly} />}</Async>
            </Panel>
            <Panel title="When you work">
              <Async query={hourlyLoad} skeleton={<Skeleton height="10rem" label="Loading activity" />} isEmpty={(d) => !d.length} compact>{() => <ActivityHeatmap data={heat} />}</Async>
            </Panel>
          </div>

          <RecentThreadsPanel threads={threads} inWindow={inWindow} activity={activity} turns={turnRows} agentsByThread={childCounts} slots={slots} projectName={projectName} />

          <div className="split split-even">
            <ToolsPanel aggregates={toolAggregates} sample={tools} picked={picks.size ? pickedTools : null} />
            <DelegationPanel threads={threads} agents={agents} forest={forest} window={settled} model={f.model} picking={picks.size > 0} activity={activity} />
          </div>
        </>
      )}

      <section className="gaps" aria-label="Measures not captured">
        <span className="gap-title">Not captured</span>
        {!models.isPending && !hasTokens && <GapCell label="Complete token total" why="No complete provider-turn total is recorded in this view." />}
        {!callsKnown && <GapCell label="Model calls" why="A provider turn can contain several model calls. Only turns are recorded." />}
        <GapCell label="Cost" why="Pricing is not captured, so no cost is derived from tokens." />
        {!turnsLoading && !resolvedKnown && <GapCell label="Resolved model" why="Only the requested model is recorded." />}
        {quotaKnown || quota.isPending ? null : <GapCell label="Quota" why="No quota snapshots exist, and past capacity cannot be reconstructed." />}
        <AppLink className="gaps-link" href={hrefPage('Data Quality')}>What is captured <ArrowUpRight size={13} aria-hidden="true" /></AppLink>
      </section>
    </>
  );
}
