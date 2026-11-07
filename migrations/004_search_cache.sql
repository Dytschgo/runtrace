-- Exact, nullable cache of already-redacted content; original JSON stays intact.
ALTER TABLE records ADD COLUMN IF NOT EXISTS search_text VARCHAR;
ALTER TABLE records ADD COLUMN IF NOT EXISTS search_version INTEGER DEFAULT 0;
