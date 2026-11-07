# Data dictionary

| Field | Meaning |
|---|---|
| id | Deterministic instance/kind/source hash |
| kind / source_id | Canonical entity kind and authoritative T3 ID |
| project_id / instance_id | Actual T3 project and configured source instance |
| thread_id / run_id | Recorded source relationships; empty means unavailable |
| occurred_at / source_updated_at | Source occurrence and projection update timestamps |
| captured_at | Collector UTC persistence timestamp |
| capture_quality | complete, partial, inferred or unavailable; source entities are conservatively partial |
| capture_source / source_version | Adapter and inspected T3 version, or unknown |
| payload_hash | Canonical data hash including attribution/encryption presence, excluding random ciphertext |
| data.content_redacted | Redacted display content, null under metadata-only capture |
| data.content_ciphertext | Optional authenticated encrypted original; excluded from HTTP/MCP |
| data.repository_path_encrypted | Optional encrypted repository path; also excluded from HTTP/MCP |
| data.content_hash | SHA-256 of original content before redaction |
| data.redaction_count / redaction_categories | Number/categories of removed values |
| model / status / tool_name / tool_category | Typed analytical cache extracted from normalized JSON |
| duration_ms | Observed completion minus start; missing/invalid timing stays null |
| input_tokens | Provider-normalized input including cached reads/writes where defined |
| cached_input_tokens | Cached input subset; never added again to total |
| output_tokens | Provider-normalized output, including reasoning subset where defined |
| reasoning_tokens | Reasoning subset; never added again to total |
| total_tokens | Input + output only for complete normalized usage, otherwise null |
| usage_status | Provider-normalized complete, partial or unavailable usage |
| redacted_characters / json_characters | Stored content and normalized JSON size counters |
| facts_version | Analytical cache hydration version, not source-data quality |
| data.thread_type / depth / root_thread_id | Primary/child/unknown and explicit subagent lineage with cycle detection |
| data.requested_model / resolved_model | Run selection; resolved model remains null without explicit evidence |
| data.agent_type / origin | T3 child versus provider-native evidence, kept distinct |
| data.delivery_state / result_returned_to_parent | Recorded completion-delivery state; true only for observed acknowledged/delivered results, otherwise null |
| external_request fields | Just Run It job/thread correlation via existing T3 thread ID; unavailable origin/device/submission fields stay null |

A model_turn entity is a provider turn, not an individual model call. Missing token, cost, first-token and historical quota telemetry is never filled with zero. Every returned entity carries provenance; API previews flag truncated display text while explicit detail queries retain the full stored redacted content.

Complete canonical per-entity tables and typed OpenAPI schemas from the original specification remain future work. See migrations and data-model.md for the actual implemented schema.

Models API/MCP aggregates now expose `cache_write_tokens` (nullable sum of observed normalized cacheCreationTokens) and `cache_write_observed_turns` (number of provider turns with that field recorded, including explicit zero). Input includes both cache-read and cache-write subsets. These values are never added again to total tokens. The dashboard does not yet display the new aggregate fields.
