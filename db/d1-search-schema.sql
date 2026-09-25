-- Baheth Masr — Cloudflare D1 search schema
-- Safe to run repeatedly: creates the required objects if they do not exist.
-- It does not delete existing data.
-- Execute with:
--   npx wrangler d1 execute baheth-masr-search --remote --file=db/d1-search-schema.sql

-- Display data for each indexed page.
CREATE TABLE IF NOT EXISTS search_pages (
  url TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT ''
);

-- Full-text search index used by the search API.
-- url is stored for joining back to search_pages, but is not tokenized.
CREATE VIRTUAL TABLE IF NOT EXISTS search_pages_fts USING fts5(
  url UNINDEXED,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
);

-- Optional verification queries. They return counts and the actual schema.
SELECT 'search_pages' AS table_name, COUNT(*) AS row_count FROM search_pages;
SELECT 'search_pages_fts' AS table_name, COUNT(*) AS row_count FROM search_pages_fts;
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
  AND name NOT LIKE 'sqlite_%'
ORDER BY type, name;
