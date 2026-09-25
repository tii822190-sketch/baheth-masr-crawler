import Database from 'better-sqlite3';

const projectUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const inputPath = process.env.CRAWLER_INPUT_DB_PATH || 'db/crawler.sqlite';
const batchSize = Math.max(1, Math.min(1000, Number(process.env.SUPABASE_MIGRATION_BATCH_SIZE || 500)));
if (!projectUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const db = new Database(inputPath, { readonly: true });
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=minimal',
};

async function post(table, rows) {
  if (!rows.length) return;
  const response = await fetch(`${projectUrl}/rest/v1/${table}`, { method: 'POST', headers, body: JSON.stringify(rows) });
  if (!response.ok) throw new Error(`${table} upload failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
}

async function uploadInBatches(table, rows) {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await post(table, batch);
    console.log(JSON.stringify({ table, uploaded: Math.min(offset + batch.length, rows.length), total: rows.length }));
  }
}

try {
  const sites = db.prepare(`SELECT id,url,crawl_status,discovery_cursor,created_at,updated_at FROM sites ORDER BY id`).all().map((row) => ({
    id: row.id, url: row.url, crawl_status: row.crawl_status, discovery_cursor: row.discovery_cursor ? JSON.parse(row.discovery_cursor) : null,
    created_at: row.created_at, updated_at: row.updated_at,
  }));
  const queue = db.prepare(`SELECT id,site_id,url,crawl_status,crawl_attempts FROM site_pages ORDER BY id`).all().map((row) => ({
    id: row.id, site_id: row.site_id, url: row.url, crawl_status: row.crawl_status, crawl_attempts: row.crawl_attempts,
  }));
  const results = db.prepare(`SELECT id,url,title,description,icon_url,keywords,snippet,created_at,updated_at FROM index_results ORDER BY id`).all();
  console.log(JSON.stringify({ source: inputPath, sites: sites.length, queue: queue.length, results: results.length, batch_size: batchSize }));
  await uploadInBatches('crawler_sites', sites);
  await uploadInBatches('crawler_queue', queue);
  await uploadInBatches('crawler_results', results);
  console.log(JSON.stringify({ ok: true, migrated: { sites: sites.length, queue: queue.length, results: results.length } }));
} finally {
  db.close();
}
