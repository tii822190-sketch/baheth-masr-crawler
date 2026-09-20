PRAGMA foreign_keys = ON;

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

CREATE INDEX IF NOT EXISTS idx_index_results_url ON index_results(url);
CREATE INDEX IF NOT EXISTS idx_index_results_created ON index_results(created_at DESC);
