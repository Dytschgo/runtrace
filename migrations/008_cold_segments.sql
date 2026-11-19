CREATE TABLE IF NOT EXISTS cold_segments (
 generation BIGINT PRIMARY KEY,
 table_name VARCHAR NOT NULL,
 path VARCHAR NOT NULL UNIQUE,
 row_count BIGINT NOT NULL,
 sha256 VARCHAR NOT NULL,
 created_at VARCHAR NOT NULL
);
-- Small identity/freshness indexes stay native; full canonical rows live in Parquet.
CREATE TABLE IF NOT EXISTS cold_record_keys (
 id VARCHAR PRIMARY KEY, generation BIGINT NOT NULL,
 instance_id VARCHAR, kind VARCHAR, source_id VARCHAR, project_id VARCHAR,
 thread_id VARCHAR, occurred_at VARCHAR, payload_hash VARCHAR,
 source_updated_at VARCHAR, source_version VARCHAR
);
CREATE TABLE IF NOT EXISTS cold_event_keys(event_id VARCHAR PRIMARY KEY,generation BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS cold_quota_sample_keys(provider VARCHAR,window_kind VARCHAR,sampled_at VARCHAR,generation BIGINT NOT NULL,PRIMARY KEY(provider,window_kind,sampled_at));
CREATE TABLE IF NOT EXISTS cold_quota_event_keys(provider VARCHAR,kind VARCHAR,happened_at VARCHAR,generation BIGINT NOT NULL,PRIMARY KEY(provider,kind,happened_at));
