import fs from 'node:fs/promises';

const rawUrl = process.env.TURSO_CRAWLER_DATABASE_URL;
const token = process.env.TURSO_CRAWLER_AUTH_TOKEN;
if (!rawUrl || !token) throw new Error('TURSO_CRAWLER_DATABASE_URL and TURSO_CRAWLER_AUTH_TOKEN are required');
const baseUrl = rawUrl.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '');
const files = ['migrations/001_crawler_staging.sql', 'migrations/002_crawler_results.sql', 'migrations/003_distribution.sql', 'migrations/004_validation.sql', 'migrations/005_classification.sql', 'migrations/006_crawl_site_queue.sql', 'migrations/007_discovery_monitoring.sql', 'migrations/008_discovery_queue.sql'];
const statements = [];
for (const file of files) {
  const sql = await fs.readFile(file, 'utf8');
  for (const statement of sql.split(';').map(x => x.trim()).filter(Boolean)) statements.push({ file, sql: statement });
}
const response = await fetch(`${baseUrl}/v2/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [...statements.map(x => ({ type: 'execute', stmt: { sql: x.sql } })), { type: 'close' }] }) });
const body = await response.json();
if (!response.ok) throw new Error(`Turso HTTP ${response.status}: ${JSON.stringify(body)}`);
const errors = body.results?.map((x, i) => ({ i, file: statements[i]?.file, error: x.response?.error || x.error })).filter(x => x.error);
const duplicateColumns = (errors || []).filter(x => /duplicate column name/i.test(JSON.stringify(x.error)));
const fatal = (errors || []).filter(x => !/duplicate column name/i.test(JSON.stringify(x.error)));
if (fatal.length) throw new Error(`Turso schema errors: ${JSON.stringify(fatal)}`);
console.log(JSON.stringify({ ok: true, statements: statements.length, duplicateColumnsIgnored: duplicateColumns.length }, null, 2));
