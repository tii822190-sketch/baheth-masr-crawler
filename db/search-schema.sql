-- Baheth Masr search database schema
-- Exactly two tables: display data and the searchable FTS index.

CREATE TABLE IF NOT EXISTS search_pages (
  url TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_pages_fts USING fts5(
  url UNINDEXED,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
);

-- The ingestion Worker writes one display row and one FTS row per URL.
-- FTS rows are replaced on re-ingestion so changed page content is searchable.
