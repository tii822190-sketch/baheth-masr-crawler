import Database from 'better-sqlite3';
const projectUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const path = process.env.CRAWLER_INPUT_DB_PATH || process.env.CRAWLER_DB_PATH || '/tmp/crawler.sqlite';
const batchSize = Math.max(1, Math.min(1000, Number(process.env.SUPABASE_MIGRATION_BATCH_SIZE || 500)));
const replaceResults = /^(1|true|yes)$/i.test(process.env.SUPABASE_REPLACE_RESULTS || '');
const syncQueueDeletes = /^(1|true|yes)$/i.test(process.env.SUPABASE_SYNC_QUEUE_DELETES || '');
if (!projectUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db = new Database(path, { readonly: true });
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
async function post(table, rows) { if (!rows.length) return; const r = await fetch(`${projectUrl}/rest/v1/${table}`, { method: 'POST', headers, body: JSON.stringify(rows) }); if (!r.ok) throw new Error(`${table} upload failed (${r.status}): ${(await r.text()).slice(0, 1000)}`); }
async function upload(table, rows) { for (let i = 0; i < rows.length; i += batchSize) await post(table, rows.slice(i, i + batchSize)); }
async function deleteQueueRows(keepIds) {
  const remoteIds = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${projectUrl}/rest/v1/crawler_queue?select=id&order=id.asc&limit=1000&offset=${offset}`, { headers });
    if (!response.ok) throw new Error(`crawler_queue ID scan failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
    const rows = await response.json();
    remoteIds.push(...rows.map((row) => Number(row.id)));
    if (rows.length < 1000) break;
  }
  const stale = remoteIds.filter((id) => !keepIds.has(id));
  for (let i = 0; i < stale.length; i += 200) {
    const ids = stale.slice(i, i + 200).join(',');
    const response = await fetch(`${projectUrl}/rest/v1/crawler_queue?id=in.(${ids})`, { method: 'DELETE', headers });
    if (!response.ok) throw new Error(`crawler_queue delete failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
  }
  return stale.length;
}
try {
  const sites = db.prepare('SELECT id,url,crawl_status,discovery_cursor,created_at,updated_at FROM sites').all().map((r) => ({ ...r, discovery_cursor: r.discovery_cursor ? JSON.parse(r.discovery_cursor) : null }));
  const queue = db.prepare('SELECT id,site_id,url,crawl_status,crawl_attempts FROM site_pages').all();
  const results = db.prepare('SELECT id,url,title,description,icon_url,keywords,snippet,created_at,updated_at FROM index_results').all();
  await upload('crawler_sites', sites); await upload('crawler_queue', queue);
  const deletedQueue = syncQueueDeletes ? await deleteQueueRows(new Set(queue.map((row) => row.id))) : 0;
  if (replaceResults) {
    const response = await fetch(`${projectUrl}/rest/v1/crawler_results?id=gte.0`, { method: 'DELETE', headers });
    if (!response.ok) throw new Error(`crawler_results cleanup failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
  }
  await upload('crawler_results', results);
  console.log(JSON.stringify({ ok: true, sites: sites.length, queue: queue.length, deleted_queue: deletedQueue, results: results.length }));
} finally { db.close(); }
