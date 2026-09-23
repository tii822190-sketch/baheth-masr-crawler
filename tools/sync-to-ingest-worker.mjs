import Database from 'better-sqlite3';

const localPath = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const ingestUrl = String(process.env.INGEST_URL || '').replace(/\/+$/, '');
const ingestToken = process.env.INGEST_TOKEN;
const batchSize = Math.min(16, Math.max(1, Number(process.env.INGEST_BATCH_SIZE || 16)));
const maxRows = Math.max(0, Number(process.env.INGEST_MAX_ROWS || 0));
const retryCount = Math.max(0, Number(process.env.INGEST_RETRIES || 5));

if (!ingestUrl || !ingestToken) throw new Error('INGEST_URL and INGEST_TOKEN are required');
const local = new Database(localPath);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendBatch(rows) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ingestToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rows }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true || body.inserted !== rows.length) {
        throw new Error(`Ingest failed (${response.status}): ${body.error || 'unexpected response'}`);
      }
      return body;
    } catch (error) {
      if (attempt >= retryCount) throw error;
      const delay = Math.min(30000, 1000 * (2 ** attempt));
      console.warn(`Worker ingest failed; retrying in ${delay}ms (${attempt + 1}/${retryCount})`);
      await sleep(delay);
    }
  }
}

try {
  const selectSql = `SELECT id,url,title,description,icon_url,keywords,snippet
    FROM index_results ORDER BY id${maxRows > 0 ? ' LIMIT ?' : ''}`;
  const localRows = maxRows > 0 ? local.prepare(selectSql).all(maxRows) : local.prepare(selectSql).all();
  const payloadRows = localRows.map(({ url, title, description, icon_url, keywords, snippet }) => ({
    url,
    title: title || '',
    description: description || '',
    icon_url: icon_url || '',
    keywords: keywords || '',
    snippet: snippet || '',
  }));

  for (let offset = 0; offset < payloadRows.length; offset += batchSize) {
    const chunk = payloadRows.slice(offset, offset + batchSize);
    await sendBatch(chunk);
    console.log(`Transferred ${Math.min(offset + chunk.length, payloadRows.length)}/${payloadRows.length} rows to D1 through Worker`);
  }

  if (localRows.length) {
    const placeholders = localRows.map(() => '?').join(',');
    const deleted = local.transaction(() =>
      local.prepare(`DELETE FROM index_results WHERE id IN (${placeholders})`).run(...localRows.map((row) => row.id)).changes,
    )();
    if (deleted !== localRows.length) throw new Error(`Expected to delete ${localRows.length} local rows, deleted ${deleted}`);
  }

  console.log(JSON.stringify({
    local_transferred: localRows.length,
    deleted_local: localRows.length,
    remote_mode: 'worker-to-d1',
    ingest_url: ingestUrl,
    dedupe_key: 'url',
    search_text_fields: ['title', 'description', 'keywords', 'snippet', 'domain'],
  }));
} finally {
  local.close();
}
