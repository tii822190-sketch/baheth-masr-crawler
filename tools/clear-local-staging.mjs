import Database from 'better-sqlite3';

const input = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite');
const results = new Database(process.env.CRAWLER_RESULTS_DB_PATH || 'db/results.sqlite');
const inputTables = ['job_lock_events','job_locks','crawl_targets','crawl_observations','crawl_discoveries','discovery_queue','site_pages','sites','crawl_runs'];
const resultTables = ['crawl_quarantine','crawl_review_items','crawl_results'];
for (const table of inputTables) input.prepare(`DELETE FROM ${table}`).run();
for (const table of resultTables) results.prepare(`DELETE FROM ${table}`).run();
input.prepare("DELETE FROM sqlite_sequence").run();
results.prepare("DELETE FROM sqlite_sequence").run();
input.close();
results.close();
console.log(JSON.stringify({ ok: true, cleared: [...inputTables, ...resultTables] }));
