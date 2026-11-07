import { hasTurnUsage } from './entities';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { tokensByKey, type ThreadTokens, type ToolStat, type ToolSummary } from './analytics';
import { getEntities, getJson, scanHourly, scanPages } from './api';
import { toAgent, toThread, toTool, toTurn, type TurnRow } from './entities';
import { apiParams, resolveFilters, type Filters, DEFAULT_RANGE } from './filters';
import { assignModelColors } from './modelColors';
import type { Entity, Envelope, HourRow, KindCount, ModelRow, QualityRow, StorageResponse, UsageRow } from './types';
import { useUrl } from './url';

const clockListeners = new Set<() => void>();
let clockTimer = 0;
const readMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

/** The current minute, as state. Without it a rolling window only moves when something else happens to render. */
export function useMinute() {
  return useSyncExternalStore((cb) => {
    clockListeners.add(cb);
    if (!clockTimer) clockTimer = window.setInterval(() => clockListeners.forEach((l) => l()), 5_000);
    return () => {
      clockListeners.delete(cb);
      if (!clockListeners.size) { window.clearInterval(clockTimer); clockTimer = 0; }
    };
  }, readMinute);
}

export function useFilters(): Filters {
  const { params, page } = useUrl();
  const minute = useMinute();
  // Every page opens on the same default window, so moving between pages never changes what is counted. Search looks through everything.
  return useMemo(() => resolveFilters(params, minute, page === 'Search' ? undefined : DEFAULT_RANGE), [params, minute, page]);
}

/** Windows reaching now keep up by themselves. A closed window in the past cannot change. */
const liveEvery = (f: Filters) => (f.until ? false : 60_000);

export const toCounts = (rows: KindCount[] | undefined) => {
  const m: Record<string, number> = {};
  for (const r of rows ?? []) m[r.kind] = r.count;
  return m;
};

const overviewKey = (f: Filters) => ['overview', apiParams('overview', f).toString()];
const fetchOverview = async (f: Filters, signal?: AbortSignal) =>
  toCounts((await getJson<Envelope<KindCount>>('overview', apiParams('overview', f), signal)).data);

export function useOverview(f: Filters, enabled = true) {
  return useQuery({ queryKey: overviewKey(f), enabled, placeholderData: keepPreviousData, refetchInterval: liveEvery(f), queryFn: ({ signal }) => fetchOverview(f, signal) });
}
export function useOverviews(list: Filters[], enabled = true) {
  return useQueries({ queries: list.map((f) => ({ queryKey: overviewKey(f), enabled, queryFn: ({ signal }: { signal: AbortSignal }) => fetchOverview(f, signal) })) });
}

export function useHourly(f: Filters) {
  return useQuery({
    queryKey: ['hourly', apiParams('activity/hourly', f).toString()],
    placeholderData: keepPreviousData,
    refetchInterval: liveEvery(f),
    queryFn: ({ signal }) => scanHourly<HourRow>(apiParams('activity/hourly', f), signal),
  });
}

export function useModels(f: Filters, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['models', apiParams('models', f).toString()],
    placeholderData: keepPreviousData,
    refetchInterval: liveEvery(f),
    queryFn: async ({ signal }) => (await getJson<Envelope<ModelRow>>('models', apiParams('models', f), signal)).data ?? [],
  });
}

const MODEL_ORDER_KEY = 'runtrace.modelOrder';
const rememberedModels = (): string[] => {
  try {
    const list = JSON.parse(localStorage.getItem(MODEL_ORDER_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string') : [];
  } catch { return []; }
};

/**
 * Model colours, busiest first. They follow all-time rank, so filtering never repaints a model.
 * The last known order is remembered, so the first paint has its colours before the slow all-time totals arrive.
 */
export function useModelSlots(enabled = true) {
  const { data } = useModels({}, enabled);
  return useMemo(() => {
    if (!data) return assignModelColors(rememberedModels());
    const ranked = [...data].sort((a, b) => (b.total_tokens ?? -1) - (a.total_tokens ?? -1) || b.observed_runs - a.observed_runs);
    const order = ranked.flatMap((m) => (m.model ? [m.model] : []));
    try { localStorage.setItem(MODEL_ORDER_KEY, JSON.stringify(order)); } catch { /* Only a head start, so it can be lost. */ }
    return assignModelColors(order);
  }, [data]);
}

const addUp = (rows: Record<string, unknown>[], key: string) => {
  const merged = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = String(row[key]);
    const into = merged.get(id);
    if (!into) { merged.set(id, { ...row }); continue; }
    for (const [k, v] of Object.entries(row)) if (typeof v === 'number') into[k] = (typeof into[k] === 'number' ? (into[k] as number) : 0) + v;
  }
  return [...merged.values()];
};

/** The API takes one model or project at a time, so a selection of several asks for each and adds the answers up. */
export function useHourlyMany(list: Filters[]) {
  return useQueries({
    queries: list.map((f) => ({ queryKey: ['hourly', apiParams('activity/hourly', f).toString()], queryFn: ({ signal }: { signal: AbortSignal }) => scanHourly<HourRow>(apiParams('activity/hourly', f), signal) })),
    combine: (results) => addUp(results.flatMap((r) => (r.data ?? []) as unknown as Record<string, unknown>[]), 'hour') as unknown as HourRow[],
  });
}
export function useToolAggregatesMany(list: Filters[]) {
  return useQueries({
    queries: list.map((f) => ({ queryKey: ['usage/tools', apiParams('usage/tools', f).toString()], retry: false, queryFn: async ({ signal }: { signal: AbortSignal }) => (await getJson<Envelope<ToolStat>>('usage/tools', apiParams('usage/tools', f), signal)).data ?? [] })),
    combine: (results) => (addUp(results.flatMap((r) => (r.data ?? []) as unknown as Record<string, unknown>[]), 'name') as unknown as ToolStat[]).sort((a, b) => b.calls - a.calls),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    refetchInterval: 120_000,
    queryFn: async ({ signal }) => (await getJson<Envelope<Entity>>('projects', new URLSearchParams({ limit: '500' }), signal)).data ?? [],
  });
}

/** Rows per page for preview scans. Each read costs about the same at any size, so fewer, bigger pages are much faster. */
export const BIG_PAGE = 5_000;
const THREAD_MAX = 20_000;
export function useThreads(f: Pick<Filters, 'project' | 'instance'>, enabled = true) {
  const params = apiParams('threads', f);
  return useQuery({
    queryKey: ['threads', params.toString()],
    enabled,
    refetchInterval: 120_000,
    queryFn: ({ signal }) => scanPages('threads', params, toThread, THREAD_MAX, signal, BIG_PAGE),
  });
}

const AGENT_MAX = 20_000;
export function useAgents(f: Pick<Filters, 'project' | 'instance'>, enabled = true) {
  const params = apiParams('agents', f);
  return useQuery({
    enabled,
    queryKey: ['agents', params.toString()],
    queryFn: ({ signal }) => scanPages('agents', params, toAgent, AGENT_MAX, signal, BIG_PAGE),
  });
}

const TURN_MAX = 50_000;
/** Provider turns hold no content, so they are cheap to read whole. */
export function useModelTurns(f: Filters, enabled = true) {
  const params = apiParams('model-turns', f);
  return useQuery({
    queryKey: ['model-turns', params.toString()],
    enabled,
    queryFn: ({ signal }) => scanPages('model-turns', params, toTurn, TURN_MAX, signal, BIG_PAGE),
  });
}

const TAIL = 200;
const RECENT_DAYS = 15;
/**
 * Every turn in scope, kept current. The last two weeks come first, which covers the default window and what it compares with,
 * and the whole history follows in the background. After that only the newest page is read, so a page left open stays true
 * without re-reading thousands of rows, and the headline, list and chart all move together.
 * New turns build up between polls, and a full page with nothing already known means some were missed, so history is read again.
 */
export function useLiveTurns(f: Pick<Filters, 'project' | 'instance'>) {
  const [coversFrom] = useState(() => Math.floor((Date.now() - RECENT_DAYS * 86_400_000) / 3_600_000) * 3_600_000);
  const recentParams = apiParams('model-turns', { project: f.project, instance: f.instance, since: new Date(coversFrom).toISOString() });
  const recent = useQuery({
    queryKey: ['turns-recent', recentParams.toString()],
    queryFn: ({ signal }) => scanPages('model-turns', recentParams, toTurn, TURN_MAX, signal, BIG_PAGE),
  });
  const all = useModelTurns({ project: f.project, instance: f.instance }, !recent.isPending);
  const queryClient = useQueryClient();
  const params = apiParams('model-turns', { project: f.project, instance: f.instance }, { limit: TAIL });
  const tailKey = ['turn-tail', params.toString()];
  const tail = useQuery({
    queryKey: tailKey,
    enabled: !!(all.data || recent.data),
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const fresh = (await getEntities<Entity>('model-turns', params, signal)).map(toTurn);
      const inHistory = new Set((all.data?.rows ?? recent.data?.rows ?? []).map((t) => t.id));
      const kept = (queryClient.getQueryData<TurnRow[]>(tailKey) ?? []).filter((t) => !inHistory.has(t.id));
      const known = new Set([...inHistory, ...kept.map((t) => t.id)]);
      if (fresh.length >= TAIL && !fresh.some((t) => known.has(t.id))) void all.refetch();
      const merged = new Map(kept.map((t) => [t.id, t]));
      for (const t of fresh) merged.set(t.id, t);
      return [...merged.values()];
    },
  });
  const rows = useMemo(() => {
    const base = all.data?.rows ?? recent.data?.rows ?? [];
    if (!tail.data?.length) return base;
    const merged = new Map(base.map((t) => [t.id, t]));
    for (const t of tail.data) merged.set(t.id, t);
    return [...merged.values()];
  }, [all.data, recent.data, tail.data]);
  return { all, recent, rows, coversFrom };
}

/** Token totals per thread, adding only turns that reported usage. */
export function useThreadTokens(f: Pick<Filters, 'project' | 'instance'>, enabled = true): Map<string, ThreadTokens> {
  const turns = useModelTurns({ project: f.project, instance: f.instance }, enabled);
  return useMemo(() => tokensByKey(turns.data?.rows ?? [], (t) => t.thread_id, (t) => t.total, hasTurnUsage), [turns.data]);
}

export function useUsage(dimension: 'projects' | 'machines', f: Filters, enabled = true) {
  const route = `usage/${dimension}`;
  const params = apiParams(route, f);
  return useQuery({
    enabled,
    queryKey: [route, params.toString()],
    retry: false,
    queryFn: async ({ signal }) => (await getJson<Envelope<UsageRow>>(route, params, signal)).data ?? [],
  });
}

export const TOOL_SAMPLE = 1000;
export const TOOL_ALL = 200_000;
const AUTO_FULL_SCAN = 10_000;
export function useToolScan(f: Filters, max = TOOL_SAMPLE, enabled = true, onProgress?: (rows: number) => void) {
  const params = apiParams('tool-calls', f);
  return useQuery({
    queryKey: ['tools', params.toString(), max],
    enabled,
    queryFn: ({ signal }) => scanPages('tool-calls', params, toTool, max, signal, 500, onProgress),
  });
}

/** Aggregate metadata across all matching stored calls without fetching their content. */
export function useToolAggregates(f: Filters, enabled = true) {
  const params = apiParams('usage/tools', f);
  return useQuery({
    enabled,
    queryKey: ['usage/tools', params.toString()], retry: false,
    placeholderData: keepPreviousData,
    // Refreshed with the daily chart, so the headline, categories and chart never drift apart in a window reaching now.
    refetchInterval: liveEvery(f),
    queryFn: async ({ signal }) => (await getJson<Envelope<ToolStat>>('usage/tools', params, signal)).data ?? [],
  });
}

/**
 * Shows the newest calls at once, then swaps in the full history when it arrives. Above the
 * automatic limit, reading everything waits for the person to ask, because each row carries its content.
 */
export function useToolAnalysis(f: Filters, forceAll = false) {
  const sample = useToolScan(f);
  const incomplete = sample.data?.complete === false;
  const total = useOverview(f, incomplete).data?.tool;
  const wantsFull = incomplete && (forceAll || (total !== undefined && total <= AUTO_FULL_SCAN));
  const [progress, setProgress] = useState(0);
  const full = useToolScan(f, TOOL_ALL, wantsFull, setProgress);
  return { query: full.data ? full : sample, reading: wantsFull && full.isFetching, progress, total, fullError: full.error };
}

/** One page of the record feed, of every kind or of one kind, filtered by the service so each page is full. */
export function useTimelinePage(f: Filters, limit: number, offset: number, kind?: string) {
  const params = apiParams('timeline', f, { limit, offset, include_content: 'false', kind });
  return useQuery({
    queryKey: ['timeline', params.toString()],
    queryFn: ({ signal }) => getEntities<Entity>('timeline', params, signal),
    placeholderData: keepPreviousData,
  });
}

export function useLatestRecord() {
  return useQuery({
    queryKey: ['latest'],
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => (await getEntities<Entity>('timeline', new URLSearchParams({ limit: '1', include_content: 'false' }), signal))[0] ?? null,
  });
}

export function useQuality() {
  return useQuery({
    queryKey: ['data-quality'],
    queryFn: ({ signal }) => getJson<QualityReport>('data-quality', undefined, signal),
    select: (report) => report.data ?? [],
  });
}

interface QualityCheckpoint { instance_id: string; project_id?: string; source_updated_at: string; last_successful_sync_at: string }
interface QualityReport extends Envelope<QualityRow> {
  checkpoints?: QualityCheckpoint[];
  project_checkpoints?: QualityCheckpoint[];
  missing_thread_relationships?: number;
  sync_progress?: { project_id?: string; project_position?: number; projects_discovered?: number; projects_completed_this_pass?: number; committed_changes_in_project?: number; state?: string }[];
  import_reports?: { project_errors?: { project_id: string; error_category: string }[]; skipped_incomplete_or_purged?: number; unchanged_source_rows_skipped?: number }[];
}
export function useQualityReport() {
  return useQuery({ queryKey: ['data-quality'], refetchInterval: 15_000, queryFn: ({ signal }) => getJson<QualityReport>('data-quality', undefined, signal) });
}
export function useCollectorReadiness() {
  return useQuery({ queryKey: ['collector-ready'], refetchInterval: 15_000, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch('/health/ready', { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as { collector?: { state?: string; last_successful_sync_at?: string } };
    },
  });
}

export function useStorage() {
  return useQuery({ queryKey: ['storage'], retry: false, queryFn: ({ signal }) => getJson<StorageResponse>('storage', undefined, signal) });
}

export type QuotaRoute = 'quota/current' | 'quota/windows' | 'quota/resets';
/** Quota readings over a span, for drawing how each window filled. Refreshed with every sync. */
export function useQuotaSamples(since: string) {
  return useQuery({ queryKey: ['quota/samples', since], placeholderData: keepPreviousData, refetchInterval: 60_000, queryFn: ({ signal }) => getJson<Envelope<Record<string, unknown>>>('quota/samples', new URLSearchParams({ since }), signal) });
}

export function useQuota(route: QuotaRoute, enabled = true) {
  return useQuery({ queryKey: [route], enabled, refetchInterval: 60_000, queryFn: ({ signal }) => getJson<Envelope<Record<string, unknown>>>(route, undefined, signal) });
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    refetchInterval: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await fetch('/health/live', { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { status: string };
    },
  });
}

/** Every tool call in the window, summarised by the service, so headline rates never come from the loaded sample. */
export function useToolSummary(f: Filters, enabled = true) {
  const params = apiParams('usage/tools', f);
  return useQuery({
    enabled,
    queryKey: ['usage/tool-summary', params.toString()], retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: liveEvery(f),
    queryFn: async ({ signal }) => (await getJson<Envelope<ToolSummary>>('usage/tool-summary', params, signal)).data?.[0] ?? null,
  });
}

export interface ToolHour { hour: string; completed: number; cancelled: number; failed: number; running: number; unknown: number }

/** Tool calls per hour by status across the whole window, for the daily chart. Older services answer 404, and the page then draws the loaded calls. */
export function useToolHours(f: Filters, enabled = true) {
  const params = apiParams('usage/tool-hours', f);
  return useQuery({
    enabled, retry: false,
    queryKey: ['usage/tool-hours', params.toString()],
    placeholderData: keepPreviousData,
    refetchInterval: liveEvery(f),
    queryFn: ({ signal }) => scanHourly<ToolHour>(params, signal, 'usage/tool-hours'),
  });
}
