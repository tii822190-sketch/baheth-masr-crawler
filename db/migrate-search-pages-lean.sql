-- Non-destructive migration for baheth-masr-search.
-- Existing search_text values are copied into the unique FTS source table.
-- No rows from search_pages or search_pages_fts are deleted.

CREATE TABLE IF NOT EXISTS search_pages_fts_keys (
  url TEXT PRIMARY KEY NOT NULL,
  search_text TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO search_pages_fts_keys (url, search_text)
SELECT url, search_text
FROM search_pages
WHERE search_text IS NOT NULL;

DROP TRIGGER IF EXISTS search_pages_after_insert;

ALTER TABLE search_pages DROP COLUMN search_text;

CREATE TRIGGER IF NOT EXISTS search_pages_fts_keys_after_insert
AFTER INSERT ON search_pages_fts_keys
BEGIN
  INSERT INTO search_pages_fts (url, search_text)
  VALUES (new.url, new.search_text);
END;
