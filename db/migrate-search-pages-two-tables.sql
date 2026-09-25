-- Consolidate baheth-masr-search to exactly two tables.
-- Existing rows in search_pages and search_pages_fts are preserved.
-- Missing FTS rows are copied from the temporary source table before it is removed.

INSERT INTO search_pages_fts (url, search_text)
SELECT k.url, k.search_text
FROM search_pages_fts_keys AS k
WHERE NOT EXISTS (
  SELECT 1
  FROM search_pages_fts AS f
  WHERE f.url = k.url
);

DROP TRIGGER IF EXISTS search_pages_fts_keys_after_insert;
DROP TABLE IF EXISTS search_pages_fts_keys;
