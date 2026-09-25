
const projectUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const path = process.env.CRAWLER_INPUT_DB_PATH || process.env.CRAWLER_DB_PATH || '/tmp/crawler.sqlite';
const pageSize = Math.max(100, Math.min(1000, Number(process.env.SUPABASE_PAGE_SIZE || 1000)));
if (!projectUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
process.env.CRAWLER_INPUT_DB_PATH = path;
const { initDb, db } = await import('../crawler/src/db.mjs');
initDb();
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
async function readAll(table, columns) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(`${projectUrl}/rest/v1/${table}?select=${columns}&order=id.asc&limit=${pageSize}&offset=${offset}`, { headers });
    if (!response.ok) throw new Error(`${table} download failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}
try {
  const sites = await readAll('crawler_sites', 'id,url,crawl_status,discovery_cursor,created_at,updated_at');
  const queue = await readAll('crawler_queue', 'id,site_id,url,crawl_status,crawl_attempts');
  const results = await readAll('crawler_results', 'id,url,title,description,icon_url,keywords,snippet,created_at,updated_at');
  const reset = db.transaction(() => {
    db.exec('DELETE FROM index_results; DELETE FROM site_pages; DELETE FROM sites;');
    const site = db.prepare('INSERT INTO sites (id,url,crawl_status,discovery_cursor,created_at,updated_at) VALUES (?,?,?,?,?,?)');
    for (const row of sites) site.run(row.id, row.url, row.crawl_status, row.discovery_cursor ? JSON.stringify(row.discovery_cursor) : null, row.created_at, row.updated_at);
    const page = db.prepare('INSERT INTO site_pages (id,site_id,url,crawl_status,crawl_attempts) VALUES (?,?,?,?,?)');
    for (const row of queue) page.run(row.id, row.site_id, row.url, row.crawl_status, row.crawl_attempts);
    const result = db.prepare('INSERT INTO index_results (id,url,title,description,icon_url,keywords,snippet,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of results) result.run(row.id, row.url, row.title, row.description, row.icon_url, row.keywords, row.snippet, row.created_at, row.updated_at);
  });
  reset();
  console.log(JSON.stringify({ ok: true, path, sites: sites.length, queue: queue.length, results: results.length }));
} finally { db.close(); }
