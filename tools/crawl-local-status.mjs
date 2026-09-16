import Database from 'better-sqlite3';
const path = process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite';
const db = new Database(path, { readonly: true });
const row = db.prepare("SELECT COUNT(*) AS pending FROM crawl_discoveries WHERE status='pending'").get();
const queued = db.prepare("SELECT COUNT(*) AS queued FROM crawl_discoveries WHERE status='queued'").get();
const targets = db.prepare("SELECT COUNT(*) AS pending_targets FROM crawl_targets WHERE status IN ('queued','processing')").get();
console.log(JSON.stringify({ pending: row.pending, queued: queued.queued, pending_targets: targets.pending_targets }));
db.close();
