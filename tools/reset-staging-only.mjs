import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rawUrl = process.env.TURSO_CRAWLER_DATABASE_URL;
const token = process.env.TURSO_CRAWLER_AUTH_TOKEN;
if (!rawUrl || !token) throw new Error('Staging Turso credentials are required');
const endpoint = rawUrl.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
const scalar = (v) => v?.value ?? null;
const quote = (n) => `"${String(n).replaceAll('"', '""')}"`;
async function pipeline(requests) {
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [...requests, { type: 'close' }] }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  const errors = (body.results || []).filter((x) => x.type === 'error' || x.response?.error);
  if (errors.length) throw new Error(`SQL error: ${JSON.stringify(errors)}`);
  return body.results || [];
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = `staging-backup-${stamp}`;
fs.mkdirSync(dir, { recursive: true });
const schemaResult = await pipeline([{ type: 'execute', stmt: { sql: "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name" } }]);
const schema = schemaResult[0].response.result;
const objects = schema.rows.map((row) => Object.fromEntries(schema.cols.map((col, i) => [col.name, scalar(row[i])] )));
fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(objects, null, 2) + '\n');
const tables = objects.filter((x) => x.type === 'table' && !String(x.name).startsWith('sqlite_')).map((x) => x.name);
const manifest = { created_at: new Date().toISOString(), tables: [], total_rows: 0 };
for (const table of tables) {
  const result = await pipeline([{ type: 'execute', stmt: { sql: `SELECT * FROM ${quote(table)}` } }]);
  const data = result[0].response.result;
  const content = data.rows.map((row) => JSON.stringify(Object.fromEntries(data.cols.map((col, i) => [col.name, scalar(row[i])] )))).join('\n') + (data.rows.length ? '\n' : '');
  const file = `${table}.jsonl`;
  fs.writeFileSync(path.join(dir, file), content);
  manifest.tables.push({ name: table, file, rows: data.rows.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  manifest.total_rows += data.rows.length;
}
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const deleteOrder = ['crawl_quarantine','crawl_review_items','crawl_results','crawl_discoveries','crawl_observations','crawl_targets','crawl_site_queue','discovery_queue','site_pages','sites','crawl_runs','job_lock_events','job_locks'];
const deletions = deleteOrder.filter((t) => tables.includes(t)).map((table) => ({ type: 'execute', stmt: { sql: `DELETE FROM ${quote(table)}` } }));
await pipeline(deletions);
const checks = await pipeline(tables.map((table) => ({ type: 'execute', stmt: { sql: `SELECT COUNT(*) AS n FROM ${quote(table)}` } })));
const remaining = checks.filter((x) => x.type === 'ok' && x.response?.result).map((x, i) => ({ table: tables[i], rows: Number(scalar(x.response.result.rows[0][0])) }));
const bad = remaining.filter((x) => x.rows !== 0 && !x.table.startsWith('site_search_fts_'));
if (bad.length) throw new Error(`Staging reset verification failed: ${JSON.stringify(bad)}`);
fs.writeFileSync(path.join(dir, 'reset-verification.json'), JSON.stringify({ remaining }, null, 2) + '\n');
const archive = `${dir}.tar.gz`;
const { execFileSync } = await import('node:child_process');
execFileSync('tar', ['-czf', archive, dir]);
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${hash}  ${archive}\n`);
console.log(JSON.stringify({ ok: true, archive, sha256: hash, backed_up_rows: manifest.total_rows, remaining }, null, 2));
