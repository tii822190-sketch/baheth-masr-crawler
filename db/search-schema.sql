-- Baheth Masr search database schema
-- Source columns mirror crawler.index_results. URL is the deduplication key.

CREATE TABLE IF NOT EXISTS search_pages (
  url TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_pages_fts USING fts5(
  url UNINDEXED,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
);
