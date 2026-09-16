const stagingUrl = process.env.TURSO_CRAWLER_DATABASE_URL;
const stagingToken = process.env.TURSO_CRAWLER_AUTH_TOKEN;
const productionUrl = process.env.TURSO_PRODUCTION_DATABASE_URL;
const productionToken = process.env.TURSO_PRODUCTION_AUTH_TOKEN;
if (!stagingUrl || !stagingToken || !productionUrl || !productionToken) throw new Error('All staging and production Turso credentials are required');
const endpoint = (value) => value.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
const scalar = (value) => value?.value ?? null;
const arg = (type, value) => ({ type, value: String(value ?? '') });
async function pipeline(url, token, requests, label = 'database') {
  const response = await fetch(endpoint(url), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [...requests, { type: 'close' }] }) });
  const body = await response.json();
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const errors = (body.results || []).filter((item) => item.type === 'error' || item.response?.error);
  if (errors.length) {
    const details = errors.map((item) => ({ index: body.results.indexOf(item), sql: requests[body.results.indexOf(item)]?.stmt?.sql?.slice(0, 180), error: item.response?.error || item.error }));
    throw Error(`${label} SQL error: ${JSON.stringify(details)}`);
  }
  return body.results || [];
}
const syncRunId = Number(process.env.CRAWLER_SYNC_RUN_ID || 0);
const runFilter = syncRunId > 0 ? ' AND r.source_run_id=?' : '';
const runArgs = syncRunId > 0 ? [arg('integer', syncRunId)] : [];
const source = await pipeline(stagingUrl, stagingToken, [{ type: 'execute', stmt: { sql: `SELECT r.id,r.requested_url,r.canonical_url,r.title,r.description,r.extracted_text,r.search_text,r.icon_url,r.content_hash,r.http_status,v.validation_status,r.category_candidate,r.subcategory_candidates_json,r.classification_confidence FROM crawl_results r JOIN crawl_review_items v ON v.result_id=r.id WHERE r.distribution_status='approved' AND v.validation_status='approved' AND length(trim(r.title))>0 AND length(trim(r.description))>0 AND length(trim(r.extracted_text))>=200${runFilter} ORDER BY r.id`, args: runArgs } }], 'staging');
const result = source[0].response.result;
const rows = result.rows.map((row) => Object.fromEntries(result.cols.map((column, index) => [column.name, scalar(row[index])] )));
if (!rows.length) throw Error('No approved staging rows available');
const categoryPriority = (category) => ({ quran: 95, religion: 90, government: 85, education: 80, health: 75, hospital: 75, healthcare: 75, news: 65, other: 50 }[String(category || 'other').toLowerCase()] || 50);
const rootUrl = new URL(rows[0].canonical_url).origin + '/';
const rootRow = rows.find((row) => row.canonical_url === rootUrl) || rows[0];
const rootCategory = rootRow.category_candidate || 'other';
const rootKeywords = rootRow.subcategory_candidates_json || '[]';
const priority = categoryPriority(rootCategory);
const rootName = rootRow.title || rootUrl;
const rootDescription = rootRow.description || '';
const requests = [{ type: 'execute', stmt: { sql: `INSERT OR IGNORE INTO sites (name,url,canonical_url,description,icon_url,keywords,categories,priority,search_text,status,last_verified_at,failed_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',CURRENT_TIMESTAMP,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, args: [arg('text', rootName), arg('text', rootUrl), arg('text', rootUrl), arg('text', rootDescription), arg('text', rootRow.icon_url || ''), arg('text', rootKeywords), arg('text', rootCategory), arg('integer', priority), arg('text', rootRow.search_text || '')] } }];
for (const row of rows) {
  const canonical = row.canonical_url || row.requested_url;
  const title = row.title || canonical;
  const description = row.description || '';
  const content = row.extracted_text || '';
  const searchText = row.search_text || `${title} ${description} ${content}`;
  const category = row.category_candidate || 'other';
  const keywords = row.subcategory_candidates_json || '[]';
  const rowPriority = categoryPriority(category) + (Number(row.classification_confidence || 0) >= 0.85 ? 5 : 0);
  const common = [arg('text', row.requested_url || canonical), arg('text', canonical), arg('text', title), arg('text', description), arg('text', content), arg('text', keywords), arg('text', category), arg('text', row.icon_url || ''), arg('text', searchText), arg('integer', rowPriority), arg('integer', row.http_status || 200), arg('text', row.content_hash || '')];
  requests.push({ type: 'execute', stmt: { sql: `INSERT OR IGNORE INTO site_pages (site_id,url,canonical_url,title,description,content,keywords,categories,icon_url,search_text,priority,status,http_status,crawl_status,content_hash,last_crawled_at,created_at,updated_at) VALUES ((SELECT id FROM sites WHERE canonical_url=?),?,?,?,?,?,?,?,?,?,?,'active',?,'crawled',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, args: [arg('text', rootUrl), ...common] } });
  requests.push({ type: 'execute', stmt: { sql: `UPDATE site_pages SET title=?,description=?,content=?,keywords=?,categories=?,icon_url=?,search_text=?,priority=?,status='active',http_status=?,crawl_status='crawled',content_hash=?,last_crawled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE canonical_url=? OR url=?`, args: [arg('text', title), arg('text', description), arg('text', content), arg('text', keywords), arg('text', category), arg('text', row.icon_url || ''), arg('text', searchText), arg('integer', rowPriority), arg('integer', row.http_status || 200), arg('text', row.content_hash || ''), arg('text', canonical), arg('text', row.requested_url || canonical)] } });
  if (canonical === rootUrl) continue;
  requests.push({ type: 'execute', stmt: { sql: `DELETE FROM site_search_fts WHERE record_type='page' AND record_id IN (SELECT CAST(id AS TEXT) FROM site_pages WHERE canonical_url=? OR url=?)`, args: [arg('text', canonical), arg('text', row.requested_url || canonical)] } });
  requests.push({ type: 'execute', stmt: { sql: `INSERT INTO site_search_fts (record_type,record_id,site_id,priority,title,description,content,keywords,categories,search_text) SELECT 'page',printf('%d',id),site_id,priority,title,description,content,keywords,categories,search_text FROM site_pages WHERE canonical_url=?`, args: [arg('text', canonical)] } });
}
requests.push({ type: 'execute', stmt: { sql: `UPDATE sites SET description=?,icon_url=?,keywords=?,categories=?,priority=?,search_text=?,updated_at=CURRENT_TIMESTAMP WHERE canonical_url=?`, args: [arg('text', rootDescription), arg('text', rootRow.icon_url || ''), arg('text', rootKeywords), arg('text', rootCategory), arg('integer', priority), arg('text', rootRow.search_text || ''), arg('text', rootUrl)] } });
requests.push({ type: 'execute', stmt: { sql: `SELECT COUNT(DISTINCT canonical_url) AS pages FROM site_pages WHERE site_id=(SELECT id FROM sites WHERE canonical_url=?) AND status='active'`, args: [arg('text', rootUrl)] } });
requests.push({ type: 'execute', stmt: { sql: `SELECT COUNT(DISTINCT record_type || ':' || record_id) AS fts FROM site_search_fts WHERE site_id=(SELECT id FROM sites WHERE canonical_url=?)`, args: [arg('text', rootUrl)] } });
const output = await pipeline(productionUrl, productionToken, requests, 'production');
const pages = output.at(-3)?.response?.result?.rows?.[0]?.[0]?.value ?? null;
const fts = output.at(-2)?.response?.result?.rows?.[0]?.[0]?.value ?? null;
if (Number(pages) < rows.length || Number(fts) < rows.length) throw Error(`Bulk verification failed: pages=${pages}, fts=${fts}, approved=${rows.length}`);
console.log(JSON.stringify({ ok: true, approved_rows: rows.length, root_url: rootUrl, production_pages: pages, production_fts: fts, categories: [...new Set(rows.map((row) => row.category_candidate || 'other'))], validation: 'approved_only_quality_and_classification' }, null, 2));
