PRAGMA foreign_keys = ON;
ALTER TABLE crawl_results ADD COLUMN parent_url TEXT NOT NULL DEFAULT '';
ALTER TABLE crawl_results ADD COLUMN site_id INTEGER;
ALTER TABLE crawl_results ADD COLUMN page_id INTEGER;
ALTER TABLE crawl_results ADD COLUMN page_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE crawl_results ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
ALTER TABLE crawl_results ADD COLUMN distribution_status TEXT NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_results_distribution ON crawl_results(distribution_status, fetched_at DESC);
CREATE TABLE IF NOT EXISTS crawl_review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, result_id INTEGER NOT NULL UNIQUE, source_run_id INTEGER, site_id INTEGER, page_id INTEGER,
  page_type TEXT NOT NULL, requested_url TEXT NOT NULL, canonical_url TEXT NOT NULL, parent_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', search_snippet TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '', extracted_text TEXT NOT NULL DEFAULT '', icon_url TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL DEFAULT '',
  quality_status TEXT NOT NULL, review_status TEXT NOT NULL DEFAULT 'pending', detected_language TEXT NOT NULL DEFAULT 'unknown',
  discovered_links_count INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS crawl_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT, result_id INTEGER NOT NULL UNIQUE, source_run_id INTEGER, requested_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL, parent_url TEXT NOT NULL DEFAULT '', http_status INTEGER, crawl_status TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL, error_message TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 1,
  retry_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_review_status ON crawl_review_items(review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_url ON crawl_review_items(canonical_url);
CREATE INDEX IF NOT EXISTS idx_quarantine_retry ON crawl_quarantine(retry_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quarantine_url ON crawl_quarantine(canonical_url);
