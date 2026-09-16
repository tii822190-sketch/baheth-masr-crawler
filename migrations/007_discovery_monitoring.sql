ALTER TABLE sites ADD COLUMN discovery_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sites ADD COLUMN last_checked_at TEXT;
ALTER TABLE sites ADD COLUMN last_discovered_at TEXT;
ALTER TABLE site_pages ADD COLUMN discovered_at TEXT;
ALTER TABLE site_pages ADD COLUMN last_checked_at TEXT;
ALTER TABLE site_pages ADD COLUMN indexed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sites_discovery_check ON sites(discovery_status,last_checked_at);
CREATE INDEX IF NOT EXISTS idx_site_pages_crawl_status ON site_pages(crawl_status,discovered_at);
