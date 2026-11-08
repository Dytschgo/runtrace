-- Each record's list view: the stored document without its full text or encrypted fields, plus a 512-character preview.
-- List pages read this instead of the whole document, which is about ten times smaller and avoids reading every tool's full output. Original JSON stays intact.
ALTER TABLE records ADD COLUMN IF NOT EXISTS preview_doc VARCHAR;
