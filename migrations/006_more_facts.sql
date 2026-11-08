-- More analytic columns, so charts and filters never read the JSON document. Original JSON stays intact.
ALTER TABLE records ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS exit_code BIGINT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS agent_provider VARCHAR;
ALTER TABLE records ADD COLUMN IF NOT EXISTS resolved_model VARCHAR;
ALTER TABLE records ADD COLUMN IF NOT EXISTS usage_scope VARCHAR;
ALTER TABLE records ADD COLUMN IF NOT EXISTS usage_source VARCHAR;
ALTER TABLE records ADD COLUMN IF NOT EXISTS has_subagents BOOLEAN;
ALTER TABLE records ADD COLUMN IF NOT EXISTS elapsed_ms BIGINT;
