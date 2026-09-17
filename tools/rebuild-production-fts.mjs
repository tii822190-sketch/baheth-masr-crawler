const raw = process.env.TURSO_PRODUCTION_DATABASE_URL;
const token = process.env.TURSO_PRODUCTION_AUTH_TOKEN;
if (!raw || !token) throw new Error('Production Turso credentials are required');
const endpoint = raw.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
const requests = [
  { type: 'execute', stmt: { sql: 'DROP TABLE IF EXISTS site_search_fts' } },
  { type: 'execute', stmt: { sql: "CREATE VIRTUAL TABLE site_search_fts USING fts5(record_type UNINDEXED, record_id UNINDEXED, site_id UNINDEXED, priority UNINDEXED, title, description, content, keywords, categories, search_text)" } },
  { type: 'execute', stmt: { sql: 'SELECT COUNT(*) AS n FROM site_search_fts' } },
  { type: 'close' },
];
const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests }) });
const body = await response.json();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
const errors = (body.results || []).filter((x) => x.type === 'error' || x.response?.error);
if (errors.length) throw new Error(`FTS rebuild error: ${JSON.stringify(errors)}`);
const count = body.results?.[2]?.response?.result?.rows?.[0]?.[0]?.value ?? null;
console.log(JSON.stringify({ ok: true, rebuilt: true, rows: Number(count) }, null, 2));
