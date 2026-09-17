import Database from 'better-sqlite3';

const runId = Number(process.env.CRAWLER_SYNC_RUN_ID || 0);
if (!runId) throw new Error('CRAWLER_SYNC_RUN_ID is required');
const db = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite');
const results = new Database(process.env.CRAWLER_RESULTS_DB_PATH || 'db/results.sqlite');
const rows = results.prepare(`
  SELECT DISTINCT page_id FROM crawl_results
  WHERE source_run_id=? AND distribution_status='approved' AND page_id IS NOT NULL
`).all(runId);
const update = db.prepare("UPDATE site_pages SET crawl_status='indexed', indexed_at=CURRENT_TIMESTAMP, last_checked_at=CURRENT_TIMESTAMP WHERE id=?");
const tx = db.transaction(() => rows.reduce((n, row) => n + update.run(row.page_id).changes, 0));
console.log(JSON.stringify({ ok: true, run_id: runId, approved_pages: rows.length, marked_indexed: tx() }, null, 2));
db.close();
results.close();
