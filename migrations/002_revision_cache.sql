CREATE TABLE IF NOT EXISTS source_revisions (
 instance_id VARCHAR NOT NULL, kind VARCHAR NOT NULL, source_id VARCHAR NOT NULL,
 revision VARCHAR NOT NULL, PRIMARY KEY(instance_id,kind,source_id)
);
CREATE INDEX IF NOT EXISTS records_kind_time ON records(kind,occurred_at);
CREATE INDEX IF NOT EXISTS records_thread ON records(thread_id);
CREATE TABLE IF NOT EXISTS snapshot_exports(directory VARCHAR PRIMARY KEY,manifest_sha256 VARCHAR NOT NULL,created_at VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS project_sync_checkpoints(instance_id VARCHAR NOT NULL,project_id VARCHAR NOT NULL,source_updated_at VARCHAR NOT NULL,last_successful_sync_at VARCHAR NOT NULL,PRIMARY KEY(instance_id,project_id));
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
