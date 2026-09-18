CREATE TABLE IF NOT EXISTS discovery_sitemap_cursor (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id),
  pending_urls TEXT NOT NULL DEFAULT '[]',
  seen_urls TEXT NOT NULL DEFAULT '[]',
  current_url TEXT NOT NULL DEFAULT '',
  current_offset INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
