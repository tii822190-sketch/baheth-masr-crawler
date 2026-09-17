import fs from 'node:fs';
const rawUrl = process.env.TURSO_CRAWLER_DATABASE_URL;
const token = process.env.TURSO_CRAWLER_AUTH_TOKEN;
if (!rawUrl || !token) throw new Error('Staging credentials required');
const endpoint = rawUrl.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'SELECT id,site_id,url,crawl_status FROM site_pages ORDER BY id' } }, { type: 'close' }] }) });
const body = await response.json();
if (!response.ok || body.results?.some((x) => x.type === 'error' || x.response?.error)) throw new Error(JSON.stringify(body));
const result = body.results[0].response.result;
const rows = result.rows.map((row) => Object.fromEntries(result.cols.map((col, i) => [col.name, row[i]?.value ?? null])));
const urls = rows.map((r) => r.url).filter(Boolean);
const counts = new Map(); for (const u of urls) counts.set(u, (counts.get(u) || 0) + 1);
const duplicates = [...counts].filter(([, n]) => n > 1);
const external = urls.filter((u) => { try { return new URL(u).hostname.replace(/^www\./, '') !== 'codenex1.blogspot.com'; } catch { return true; } });
const out = [
  `total=${rows.length}`,
  `duplicates=${duplicates.length}`,
  `external=${external.length}`,
  '',
  ...rows.map((r, i) => `${i + 1}. ${r.url} [status=${r.crawl_status || 'pending'}]`),
  '',
  'DUPLICATES:', ...duplicates.map(([u, n]) => `${n}x ${u}`),
  '',
  'EXTERNAL:', ...external,
].join('\n') + '\n';
fs.writeFileSync('staging-links.txt', out);
console.log(JSON.stringify({ total: rows.length, duplicates: duplicates.length, external: external.length, output: 'staging-links.txt' }, null, 2));
