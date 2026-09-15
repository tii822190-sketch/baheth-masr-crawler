import Database from 'better-sqlite3';

const endpoint = process.env.GOOGLE_SHEETS_WEB_APP_URL;
if (!endpoint) throw new Error('Set GOOGLE_SHEETS_WEB_APP_URL to the deployed Apps Script Web App URL');
const token = process.env.GOOGLE_SHEETS_TOKEN || '';
const resultsDb = new Database(process.env.CRAWLER_RESULTS_DB_PATH || 'db/results.sqlite', { readonly:true });
const linksDb = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite', { readonly:true });
const results = resultsDb.prepare('SELECT * FROM crawl_results ORDER BY id').all();
const discoveries = linksDb.prepare('SELECT * FROM crawl_discoveries ORDER BY id').all();
const run = linksDb.prepare('SELECT id,run_type,status,started_at,finished_at,target_count,processed_count,success_count,failed_count FROM crawl_runs ORDER BY id DESC LIMIT 1').get() || {};
const response = await fetch(endpoint, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ token, run:{...run,source_run_id:run.id,runId:run.id}, results, discoveries }) });
const text = await response.text();
if (!response.ok) throw new Error(`Google Sheets HTTP ${response.status}: ${text}`);
console.log(text);
resultsDb.close(); linksDb.close();
