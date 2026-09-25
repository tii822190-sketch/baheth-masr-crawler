
const projectUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const path = process.env.CRAWLER_INPUT_DB_PATH || process.env.CRAWLER_DB_PATH || '/tmp/crawler.sqlite';
const pageSize = Math.max(100, Math.min(1000, Number(process.env.SUPABASE_PAGE_SIZE || 1000)));
const queueMode = String(process.env.SUPABASE_QUEUE_MODE || 'full').toLowerCase();
const queueLimit = Math.max(1, Number(process.env.SUPABASE_QUEUE_LIMIT || 5000));
const sitesMode = String(process.env.SUPABASE_SITES_MODE || 'full').toLowerCase();
const manifestPath = process.env.SUPABASE_QUEUE_MANIFEST_PATH || `${path}.queue-manifest.json`;
if (!projectUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
process.env.CRAWLER_INPUT_DB_PATH = path;
const { initDb, db } = await import('../crawler/src/db.mjs');
initDb();
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
async function readAll(table, columns) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${projectUrl}/rest/v1/${table}`);
    url.searchParams.set('select', columns);
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${table} download failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    const batch = await response.json(); rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}
async function readQueueBatch() {
  if (queueMode === 'none') return { rows: [], source: 'none' };
  if (queueMode !== 'batch') return { rows: await readAll('crawler_queue', 'id,site_id,url,crawl_status,crawl_attempts'), source: 'full' };
  async function readStatus(status, offset = 0, limit = queueLimit) {
    const url = new URL(`${projectUrl}/rest/v1/crawler_queue`);
    url.searchParams.set('select', 'id,site_id,url,crawl_status,crawl_attempts');
    url.searchParams.set('crawl_status', `eq.${status}`);
    if (status === 'needs_review') url.searchParams.set('crawl_attempts', 'lt.2');
    url.searchParams.set('order', 'id.asc'); url.searchParams.set('limit', String(limit)); url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`crawler_queue download failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    return response.json();
  }
  let rows = await readStatus('pending');
  if (!rows.length) rows = await readStatus('needs_review');
  return { rows: rows.slice(0, queueLimit), source: 'batch' };
}
try {
  const sites = sitesMode === 'none' ? [] : await readAll('crawler_sites', 'id,url,category,crawl_status,discovery_cursor,created_at,updated_at');
  const queueResult = await readQueueBatch();
  const results = await readAll('crawler_results', 'id,url,title,description,icon_url,snippet,created_at,updated_at');
  const reset = db.transaction(() => {
    db.exec('DELETE FROM index_results; DELETE FROM site_pages; DELETE FROM sites;');
    const site = db.prepare("INSERT INTO sites (id,url,category,crawl_status,discovery_cursor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
    for (const row of sites) site.run(row.id, row.url, row.category || 'ديني', row.crawl_status, row.discovery_cursor ? JSON.stringify(row.discovery_cursor) : null, row.created_at, row.updated_at);
    const page = db.prepare('INSERT INTO site_pages (id,site_id,url,crawl_status,crawl_attempts) VALUES (?,?,?,?,?)');
    for (const row of queueResult.rows) page.run(row.id, row.site_id, row.url, row.crawl_status, row.crawl_attempts);
    const result = db.prepare('INSERT INTO index_results (id,url,title,description,icon_url,keywords,snippet,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of results) result.run(row.id, row.url, row.title, row.description, row.icon_url, row.keywords || '', row.snippet, row.created_at, row.updated_at);
  });
  reset();
  if (queueResult.source === 'batch') {
    const fs = await import('node:fs/promises');
    await fs.writeFile(manifestPath, JSON.stringify({ ids: queueResult.rows.map((row) => Number(row.id)), mode: 'batch' }));
  }
  console.log(JSON.stringify({ ok: true, path, sites: sites.length, queue: queueResult.rows.length, queue_mode: queueResult.source, results: results.length }, null, 2));
} finally { db.close(); }
