import { cleanText, repairText, validDate, isKnown } from './format';
import type { Entity, Json } from './types';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (isKnown(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Prefers a backend duration; otherwise derives it. Null means unknown, never zero. */
export function durationMs(d: Json): number | null {
  const direct = num(d.duration_ms);
  if (direct !== null && direct >= 0) return direct;
  const a = validDate(d.started_at);
  const b = validDate(d.completed_at);
  if (!a || !b) return null;
  const ms = b.getTime() - a.getTime();
  return ms >= 0 ? ms : null;
}

export interface ThreadRow {
  id: string; source_id: string; instance_id: string; project_id: string;
  occurred_at: string; updated_at: string | null; quality: string; version: string | null;
  title: string; type: string; parent: string | null; root: string | null; depth: number | null;
  resolved: boolean | null; relationship: string | null; branch: string | null; model: string | null;
  archived: string | null; worktree: boolean | null; tokens: number | null; toolCoverage: string | null;
}

export function toThread(e: Entity): ThreadRow {
  const d = e.data ?? {};
  const usage = d.token_usage;
  return {
    id: e.id, source_id: e.source_id, instance_id: e.instance_id, project_id: e.project_id,
    occurred_at: e.occurred_at, updated_at: e.source_updated_at ?? null, quality: e.capture_quality ?? 'unavailable', version: e.source_version ?? null,
    title: repairText(str(d.title) ?? '') || 'Untitled thread',
    type: str(d.thread_type) ?? 'unknown', parent: str(d.parent_thread_id), root: str(d.root_thread_id),
    depth: num(d.depth), resolved: bool(d.lineage_resolved), relationship: str(d.relationship_to_parent),
    branch: str(d.branch), model: str(d.model), archived: str(d.archived_at), worktree: bool(d.worktree_available),
    tokens: isKnown(usage) ? usage : usage && typeof usage === 'object' ? num((usage as Json).total_tokens) : null,
    toolCoverage: str(d.tool_coverage),
  };
}

/** Reads one string field out of JSON that was cut short, as a list preview is. */
export function readCutField(raw: string, key: string): string | null {
  const marker = `"${key}":"`;
  const start = raw.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  let end = from;
  while (end < raw.length && raw[end] !== '"') end += raw[end] === '\\' ? 2 : 1;
  const fragment = raw.slice(from, Math.min(end, raw.length)).replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
  try {
    return JSON.parse(`"${fragment}"`) as string;
  } catch {
    return fragment;
  }
}

export interface ParsedContent { fields: Json | null; raw: string | null; truncated: boolean }
export function parseContent(d: Json): ParsedContent {
  const raw = str(d.content_redacted);
  const truncated = d.content_truncated === true;
  if (!raw) return { fields: null, raw: null, truncated };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { fields: parsed as Json, raw, truncated };
  } catch { /* a preview is cut mid-string, and redaction can also break the JSON; show it as stored */ }
  if (truncated) {
    const fields: Json = {};
    for (const key of ['arguments', 'diff', 'result', 'task']) {
      const v = readCutField(raw, key);
      if (v !== null) fields[key] = v;
    }
    if (Object.keys(fields).length) return { fields, raw, truncated };
  }
  return { fields: null, raw, truncated };
}

export function contentField(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return cleanText(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

export interface AgentRow {
  id: string; source_id: string; thread_id: string; run_id: string; project_id: string; instance_id: string;
  occurred_at: string; quality: string; agentType: string; child: string | null; parentRun: string | null;
  model: string | null; status: string | null; started: string | null; completed: string | null;
  duration: number | null; returned: boolean | null; task: string | null; result: string | null; redactions: number | null; categories: string[];
}

const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

export function toAgent(e: Entity): AgentRow {
  const d = e.data ?? {};
  const c = parseContent(d);
  return {
    id: e.id, source_id: e.source_id, thread_id: e.thread_id, run_id: e.run_id, project_id: e.project_id, instance_id: e.instance_id,
    occurred_at: e.occurred_at, quality: e.capture_quality ?? 'unavailable', agentType: str(d.agent_type) ?? 'unknown',
    child: str(d.child_thread_id), parentRun: str(d.parent_agent_run_id), model: str(d.model), status: str(d.status),
    started: str(d.started_at), completed: str(d.completed_at), duration: durationMs(d), returned: bool(d.result_returned_to_parent),
    task: clip(contentField(c.fields?.task), 1200), result: clip(contentField(c.fields?.result), 1200),
    redactions: num(d.redaction_count), categories: Array.isArray(d.redaction_categories) ? (d.redaction_categories as string[]) : [],
  };
}

/** Strips the Windows shell wrapper so a preview starts with the command that ran. */
export function commandPreview(args: string): string {
  const inner = args.match(/-Command\s+"?([\s\S]+)$/);
  return (inner ? inner[1] : args).replace(/^[\\"'@\s]+/, '').replace(/\s+/g, ' ').trim();
}

export interface ToolRow {
  id: string; source_id: string; thread_id: string; run_id: string; project_id: string; occurred_at: string; quality: string;
  name: string; category: string; model: string | null; status: string | null; exit: number | null; duration: number | null; chars: number | null;
  redactions: number | null; categories: string[]; preview: string; parent: string | null;
}

/** Keeps only metadata and a short preview so scans hold little memory; full content is refetched on demand. */
export function toTool(e: Entity): ToolRow {
  const d = e.data ?? {};
  const c = parseContent(d);
  const args = c.fields
    ? contentField(c.fields.arguments) ?? contentField(c.fields.diff) ?? contentField(c.fields.result) ?? ''
    : (c.raw ?? '').replace(/^\{"(arguments|diff|result)":(null,"(diff|result)":)?"?/, '').replace(/\\n/g, ' ').replace(/\\"/g, '"');
  return {
    id: e.id, source_id: e.source_id, thread_id: e.thread_id, run_id: e.run_id, project_id: e.project_id, occurred_at: e.occurred_at,
    quality: e.capture_quality ?? 'unavailable', name: str(d.tool_name) ?? 'unknown', category: str(d.tool_category) ?? 'unknown', model: str(d.model),
    status: str(d.status), exit: num(d.exit_code), duration: durationMs(d), chars: num(d.character_count), redactions: num(d.redaction_count),
    categories: Array.isArray(d.redaction_categories) ? (d.redaction_categories as string[]) : [],
    preview: commandPreview(args.slice(0, 400)).slice(0, 160), parent: str(d.parent_tool_call_id),
  };
}

/** Provider thread ids read like provider-thread:provider:codex:native-thread:abc, so the agent is known even when its own field is empty. */
export function providerFromThread(id: unknown): string | null {
  return typeof id === 'string' ? /(?:^|:)provider:([^:]+)/.exec(id)?.[1] ?? null : null;
}

/** One provider turn: a main-agent turn as the provider reported it. It can contain several model calls, which are not captured. */
export interface TurnRow {
  id: string; source_id: string; thread_id: string; run_id: string; project_id: string; instance_id: string; occurred_at: string; quality: string;
  provider: string | null; model: string | null; resolved: string | null; status: string | null; duration: number | null;
  cacheWrite?: number | null;
  input: number | null; cached: number | null; output: number | null; reasoning: number | null; total: number | null;
  usage: string; scope: string | null; hasSubagents: boolean | null;
  /** Usage read from an agent's own session log: an hour of calls, not a provider turn. */
  log?: boolean;
}
export function toTurn(e: Entity): TurnRow {
  const d = e.data ?? {};
  return {
    id: e.id, source_id: e.source_id, thread_id: e.thread_id, run_id: e.run_id, project_id: e.project_id, instance_id: e.instance_id, occurred_at: e.occurred_at,
    quality: e.capture_quality ?? 'unavailable', provider: str(d.provider) ?? providerFromThread(d.provider_thread_id), model: str(d.model) ?? str(d.requested_model), resolved: str(d.resolved_model), status: str(d.status),
    cacheWrite: num(d.cache_write_tokens), duration: durationMs(d), input: num(d.input_tokens), cached: num(d.cached_input_tokens), output: num(d.output_tokens), reasoning: num(d.reasoning_tokens), total: num(d.total_tokens),
    usage: str(d.usage_status) ?? 'unavailable', scope: str(d.usage_scope), hasSubagents: bool(d.has_subagents),
    log: d.usage_source === 'session_log',
  };
}

export interface RunRow {
  source_id: string; occurred_at: string; provider: string | null; requested: string | null; resolved: string | null; status: string | null;
  started: string | null; completed: string | null; duration: number | null;
  input: number | null; cached: number | null; output: number | null; reasoning: number | null; total: number | null;
}
export function toRun(e: Entity): RunRow {
  const d = e.data ?? {};
  return {
    source_id: e.source_id, occurred_at: e.occurred_at, provider: str(d.provider), requested: str(d.requested_model), resolved: str(d.resolved_model),
    status: str(d.status), started: str(d.started_at), completed: str(d.completed_at), duration: durationMs(d),
    input: num(d.input_tokens), cached: num(d.cached_input_tokens), output: num(d.output_tokens), reasoning: num(d.reasoning_tokens), total: num(d.total_tokens),
  };
}

export function hasTurnUsage(t: TurnRow): boolean { return [t.total,t.input,t.cached,t.cacheWrite,t.output,t.reasoning].some((v) => v !== null && v !== undefined); }
