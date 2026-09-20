ALTER TABLE site_pages ADD COLUMN crawl_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_site_pages_status_attempts ON site_pages(crawl_status,crawl_attempts,id);
