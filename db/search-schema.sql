-- Baheth Masr search database schema
-- Main rows contain only fields returned to clients.
-- Full search text is stored separately and indexed by FTS5.

CREATE TABLE IF NOT EXISTS search_pages (
  url TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS search_pages_fts_keys (
  url TEXT PRIMARY KEY NOT NULL,
  search_text TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_pages_fts USING fts5(
  url UNINDEXED,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
);

-- The ingestion Worker writes only to these two ordinary tables.
-- This trigger writes the FTS row without any SELECT/read request.
CREATE TRIGGER IF NOT EXISTS search_pages_fts_keys_after_insert
AFTER INSERT ON search_pages_fts_keys
BEGIN
  INSERT INTO search_pages_fts (url, search_text)
  VALUES (new.url, new.search_text);
END;
