PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS crawl_results (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source_run_id INTEGER, run_type TEXT NOT NULL DEFAULT 'manual', source_target_id INTEGER,
 requested_url TEXT NOT NULL, canonical_url TEXT NOT NULL, response_url TEXT NOT NULL DEFAULT '', http_status INTEGER,
 crawl_status TEXT NOT NULL, fetch_method TEXT NOT NULL DEFAULT 'http', content_type TEXT NOT NULL DEFAULT '', content_length INTEGER NOT NULL DEFAULT 0,
 title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', search_snippet TEXT NOT NULL DEFAULT '',
 icon_url TEXT NOT NULL DEFAULT '', extracted_text TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL DEFAULT '',
 quality_status TEXT NOT NULL DEFAULT 'review', review_status TEXT NOT NULL DEFAULT 'review', detected_language TEXT NOT NULL DEFAULT 'unknown',
 is_dynamic INTEGER NOT NULL DEFAULT 0, is_api INTEGER NOT NULL DEFAULT 0,
 links_json TEXT NOT NULL DEFAULT '[]', internal_links_json TEXT NOT NULL DEFAULT '[]', external_links_json TEXT NOT NULL DEFAULT '[]', social_links_json TEXT NOT NULL DEFAULT '[]',
 discovered_links_count INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, duration_ms INTEGER NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_results_url_time ON crawl_results(canonical_url,fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_quality ON crawl_results(quality_status,review_status);
CREATE INDEX IF NOT EXISTS idx_results_run ON crawl_results(source_run_id);
