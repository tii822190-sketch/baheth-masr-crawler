PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 70,
  last_crawled_at TEXT,
  last_weekly_refresh_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_pages (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  http_status INTEGER,
  crawl_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL CHECK (run_type IN ('daily_check','weekly_refresh','manual')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  started_at TEXT,
  finished_at TEXT,
  requested_by TEXT NOT NULL DEFAULT 'github-actions',
  target_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crawl_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('site','page','discovered_url')),
  site_id INTEGER REFERENCES sites(id),
  page_id INTEGER REFERENCES site_pages(id),
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 70,
  reason TEXT NOT NULL DEFAULT 'daily_check',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crawl_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES crawl_targets(id),
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  http_status INTEGER,
  response_url TEXT NOT NULL DEFAULT '',
  crawl_status TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  content_length INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  extracted_text TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crawl_discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  source_site_id INTEGER REFERENCES sites(id),
  source_page_id INTEGER REFERENCES site_pages(id),
  discovered_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  discovery_source TEXT NOT NULL,
  discovered_from_url TEXT NOT NULL DEFAULT '',
  title_hint TEXT NOT NULL DEFAULT '',
  description_hint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crawl_targets_run_status ON crawl_targets(run_id,status);
CREATE INDEX IF NOT EXISTS idx_crawl_targets_priority ON crawl_targets(status,priority DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_observations_target ON crawl_observations(target_id,fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_created ON crawl_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_discoveries_status ON crawl_discoveries(status,discovered_at DESC);
