ALTER TABLE crawl_review_items ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE crawl_review_items ADD COLUMN validation_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE crawl_review_items ADD COLUMN validated_at TEXT;
ALTER TABLE crawl_review_items ADD COLUMN validator_version TEXT NOT NULL DEFAULT 'v1';
CREATE INDEX IF NOT EXISTS idx_review_validation ON crawl_review_items(validation_status, validated_at DESC);
