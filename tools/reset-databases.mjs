import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = `reset-backup-${stamp}`;
fs.mkdirSync(root, { recursive: true });
const configs = [
  ['production', process.env.TURSO_PRODUCTION_DATABASE_URL, process.env.TURSO_PRODUCTION_AUTH_TOKEN],
  ['staging', process.env.TURSO_CRAWLER_DATABASE_URL, process.env.TURSO_CRAWLER_AUTH_TOKEN],
];
for (const [name, rawUrl, token] of configs) {
  if (!rawUrl || !token) throw new Error(`${name} Turso credentials are required`);
}
const endpoint = (rawUrl) => rawUrl.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
async function pipeline(rawUrl, token, requests) {
  const response = await fetch(endpoint(rawUrl), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [...requests, { type: 'close' }] }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  const errors = (body.results || []).filter((x) => x.type === 'error' || x.response?.error);
  if (errors.length) throw new Error(`SQL error: ${JSON.stringify(errors)}`);
  return body.results || [];
}
const scalar = (value) => value?.value ?? null;
const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const manifests = [];
for (const [name, rawUrl, token] of configs) {
  const schemaResult = await pipeline(rawUrl, token, [{ type: 'execute', stmt: { sql: "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name" } }]);
  const schema = schemaResult[0].response.result;
  const objects = schema.rows.map((row) => Object.fromEntries(schema.cols.map((col, i) => [col.name, scalar(row[i])] )));
  fs.writeFileSync(path.join(root, `${name}-schema.json`), JSON.stringify(objects, null, 2) + '\n');
  const tables = objects.filter((x) => x.type === 'table' && !String(x.name).startsWith('sqlite_')).map((x) => x.name);
  const manifest = { name, created_at: new Date().toISOString(), tables: [], total_rows: 0 };
  for (const table of tables) {
    const result = await pipeline(rawUrl, token, [{ type: 'execute', stmt: { sql: `SELECT * FROM ${quote(table)}` } }]);
    const data = result[0].response.result;
    const rows = data.rows.map((row) => Object.fromEntries(data.cols.map((col, i) => [col.name, scalar(row[i])] )));
    const file = `${name}-${table.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`;
    const content = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    fs.writeFileSync(path.join(root, file), content);
    manifest.tables.push({ name: table, file, rows: rows.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
    manifest.total_rows += rows.length;
  }
  if (!manifest.tables.length) throw new Error(`${name} has no tables; refusing reset`);
  fs.writeFileSync(path.join(root, `${name}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  manifests.push({ name, rawUrl, token, tables });
}
fs.writeFileSync(path.join(root, 'reset-manifest.json'), JSON.stringify({ created_at: new Date().toISOString(), databases: manifests.map((x) => ({ name: x.name, tables: x.tables })) }, null, 2) + '\n');
for (const { name, rawUrl, token, tables } of manifests) {
  const productionOrder = ['site_search_fts', 'site_pages', 'sites'];
  const stagingOrder = ['crawl_quarantine', 'crawl_review_items', 'crawl_results', 'crawl_observations', 'crawl_discoveries', 'crawl_targets', 'site_pages', 'sites', 'crawl_runs'];
  const preferred = name === 'production' ? productionOrder : stagingOrder;
  const deletions = preferred.filter((table) => tables.includes(table)).map((table) => ({ type: 'execute', stmt: { sql: `DELETE FROM ${quote(table)}` } }));
  await pipeline(rawUrl, token, deletions);
  const checks = await pipeline(rawUrl, token, tables.map((table) => ({ type: 'execute', stmt: { sql: `SELECT COUNT(*) AS n FROM ${quote(table)}` } })));
  const remaining = checks.map((result, index) => ({ table: tables[index], rows: Number(scalar(result.response.result.rows[0][0])) }));
  if (remaining.some((x) => x.rows !== 0)) throw new Error(`${name} reset verification failed: ${JSON.stringify(remaining)}`);
  fs.writeFileSync(path.join(root, `${name}-reset-verification.json`), JSON.stringify({ name, remaining }, null, 2) + '\n');
}
const archive = `${root}.tar.gz`;
const { execFileSync } = await import('node:child_process');
execFileSync('tar', ['-czf', archive, root]);
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${hash}  ${archive}\n`);
console.log(JSON.stringify({ ok: true, backup_directory: root, archive, sha256: hash, databases: manifests.map((x) => ({ name: x.name, tables: x.tables })) }, null, 2));
