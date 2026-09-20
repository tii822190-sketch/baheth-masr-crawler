PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL UNIQUE,
  crawl_status TEXT NOT NULL DEFAULT 'pending',
  crawl_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS index_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_site_pages_status ON site_pages(crawl_status,id);
CREATE INDEX IF NOT EXISTS idx_site_pages_site ON site_pages(site_id,id);
CREATE INDEX IF NOT EXISTS idx_index_results_url ON index_results(url);
