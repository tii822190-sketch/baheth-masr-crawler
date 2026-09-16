import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const url = process.env.TURSO_PRODUCTION_DATABASE_URL;
const token = process.env.TURSO_PRODUCTION_AUTH_TOKEN;
if (!url || !token) throw new Error('Production Turso credentials are required');
const endpoint = url.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
async function pipeline(requests) {
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [...requests, { type: 'close' }] }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  const errors = (body.results || []).filter((item) => item.type === 'error' || item.response?.error);
  if (errors.length) throw new Error(`SQL error: ${JSON.stringify(errors)}`);
  return body.results || [];
}
const scalar = (value) => value?.value ?? null;
const root = 'backup-output';
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const schemaResult = await pipeline([{ type: 'execute', stmt: { sql: "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name" } }]);
const schema = schemaResult[0].response.result;
const objects = schema.rows.map((row) => Object.fromEntries(schema.cols.map((col, i) => [col.name, scalar(row[i])] )));
fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify(objects, null, 2) + '\n');
const tables = objects.filter((item) => item.type === 'table' && !item.name.startsWith('sqlite_')).map((item) => item.name);
const manifest = { created_at: new Date().toISOString(), tables: [], total_rows: 0 };
for (const table of tables) {
  const quoted = table.replaceAll('"', '""');
  const result = await pipeline([{ type: 'execute', stmt: { sql: `SELECT * FROM "${quoted}"` } }]);
  const data = result[0].response.result;
  const rows = data.rows.map((row) => Object.fromEntries(data.cols.map((col, i) => [col.name, scalar(row[i])] )));
  const file = `${table.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`;
  const content = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(path.join(root, file), content);
  manifest.tables.push({ name: table, file, rows: rows.length, columns: data.cols.map((col) => col.name), sha256: crypto.createHash('sha256').update(content).digest('hex') });
  manifest.total_rows += rows.length;
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const archive = 'production-backup.tar.gz';
const { execFileSync } = await import('node:child_process');
execFileSync('tar', ['-czf', archive, root]);
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${hash}  ${archive}\n`);
console.log(JSON.stringify({ ok: true, archive, sha256: hash, tables: manifest.tables.length, total_rows: manifest.total_rows }, null, 2));
