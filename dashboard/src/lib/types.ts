export type Json = Record<string, unknown>;

export interface Envelope<T = unknown> {
  data: T[];
  capture_quality?: string;
  limit?: number;
  offset?: number;
  timezone?: string;
  null_semantics?: string;
  /** Optional: a future backend may report the unpaged row count. */
  total?: number;
  reason?: string;
  window_status?: string;
}

export interface Entity {
  id: string;
  source_id: string;
  kind: string;
  instance_id: string;
  project_id: string;
  thread_id: string;
  run_id: string;
  occurred_at: string;
  source_updated_at?: string;
  capture_quality?: string;
  capture_source?: string;
  source_version?: string;
  captured_at?: string;
  data: Json;
}

export interface KindCount { kind: string; count: number }
export interface HourRow { hour: string; prompts: number }
export interface ModelRow {
  model: string | null;
  observed_runs: number;
  calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  capture_quality?: string;
  /** Present from the provider-turn backend onward. Null means the provider did not report it. */
  observed_provider_turns?: number | null;
  /** Threads and sub-agents that name this model, counted by the service in the same pass. */
  observed_threads?: number;
  observed_agents?: number;
  cached_input_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_write_observed_turns?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
  turns_with_usage?: number | null;
  complete_usage_turns?: number | null;
  /** Hours of tokens read from an agent's session log. Never provider turns. */
  session_log_blocks?: number | null;
  median_latency_ms?: number | null;
  p95_latency_ms?: number | null;
}
export interface UsageRow {
  identity: string;
  dimension: string;
  observed_threads?: number;
  observed_prompts: number;
  observed_answers: number;
  observed_runs: number;
  observed_provider_turns: number;
  /** Provider turns that reported a complete total. Fewer than all turns makes the token total a lower bound. */
  reported_turns?: number;
  observed_tool_calls: number;
  observed_agents: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  capture_quality?: string;
}
export interface QualityRow { kind: string; capture_quality: string; count: number }
export interface StorageResponse {
  rows?: { table: string; rows: number }[];
  events?: number;
  capture_source?: string;
  duckdb_bytes?: number | null;
  redacted_content_characters?: number | null;
  normalized_json_characters?: number | null;
  oldest_at?: string | null;
  newest_at?: string | null;
  /** Optional; rendered only when the API sends it. */
  archive_bytes?: number | null;
}
