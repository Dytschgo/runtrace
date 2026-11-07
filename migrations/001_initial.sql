CREATE TABLE IF NOT EXISTS records (
 id VARCHAR PRIMARY KEY, kind VARCHAR NOT NULL, instance_id VARCHAR NOT NULL,
 source_id VARCHAR NOT NULL, project_id VARCHAR, thread_id VARCHAR, run_id VARCHAR,
 occurred_at VARCHAR NOT NULL, source_updated_at VARCHAR NOT NULL,
 capture_quality VARCHAR NOT NULL, capture_source VARCHAR NOT NULL,
 source_version VARCHAR NOT NULL, captured_at VARCHAR NOT NULL,
 payload_hash VARCHAR NOT NULL, data JSON NOT NULL,
 UNIQUE(instance_id,kind,source_id)
);
CREATE TABLE IF NOT EXISTS events (
 event_id VARCHAR PRIMARY KEY, entity_id VARCHAR NOT NULL, event_type VARCHAR NOT NULL,
 occurred_at VARCHAR NOT NULL, received_at VARCHAR NOT NULL, payload_hash VARCHAR NOT NULL,
 instance_id VARCHAR NOT NULL, project_id VARCHAR, thread_id VARCHAR,
 capture_quality VARCHAR NOT NULL, capture_source VARCHAR NOT NULL,
 source_version VARCHAR NOT NULL, source_updated_at VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints(instance_id VARCHAR PRIMARY KEY, source_updated_at VARCHAR NOT NULL, last_successful_sync_at VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key VARCHAR PRIMARY KEY,value VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS tombstones(scope VARCHAR NOT NULL, source_id VARCHAR NOT NULL, purged_at VARCHAR NOT NULL, PRIMARY KEY(scope,source_id));
CREATE TABLE IF NOT EXISTS archives(path VARCHAR PRIMARY KEY,sha256 VARCHAR NOT NULL,row_count BIGINT NOT NULL,created_at VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMP DEFAULT current_timestamp);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
