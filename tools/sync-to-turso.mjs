import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';

const localPath = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const pagesTable = 'search_pages';
const ftsTable = 'search_pages_fts';
const batchSize = Math.max(1, Number(process.env.TURSO_BATCH_SIZE || 250));
const maxRows = Math.max(0, Number(process.env.TURSO_MAX_ROWS || 0));
const retryCount = Math.max(0, Number(process.env.TURSO_RETRIES || 5));

if (!tursoUrl || !tursoAuthToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
const local = new Database(localPath);
const remote = createClient({ url: tursoUrl, authToken: tursoAuthToken });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function remoteBatch(statements) {
  if (!statements.length) return;
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Explicitly use the write transaction mode. No remote SELECT is used here.
      return await remote.batch(statements, 'write');
    } catch (error) {
      if (attempt >= retryCount) throw error;
      const delay = Math.min(30000, 1000 * (2 ** attempt));
      console.warn(`Turso write batch failed; retrying in ${delay}ms (${attempt + 1}/${retryCount})`);
      await sleep(delay);
    }
  }
}

function pageValues(row) {
  return [
    row.url,
    row.title || '',
    row.description || '',
    row.icon_url || '',
    row.snippet || row.content || '',
    row.keywords || '',
  ];
}

function statementsForRow(row) {
  const values = pageValues(row);
  return [
    {
      sql: `INSERT INTO ${pagesTable} (url,title,description,icon_url,snippet,keywords)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(url) DO UPDATE SET
          title=excluded.title,
          description=excluded.description,
          icon_url=excluded.icon_url,
          snippet=excluded.snippet,
          keywords=excluded.keywords`,
      args: values,
    },
    // FTS5 has no reliable upsert across all SQLite/libSQL versions.
    // Delete and reinsert only this URL; never rebuild the full FTS table.
    {
      sql: `DELETE FROM ${ftsTable} WHERE url=?`,
      args: [row.url],
    },
    {
      sql: `INSERT INTO ${ftsTable} (url,title,description,icon_url,snippet,keywords)
        VALUES (?,?,?,?,?,?)`,
      args: values,
    },
  ];
}

try {
  // The only reads in this program are local SQLite reads. The remote database
  // is treated as a write target and is never inspected or counted.
  const selectSql = `SELECT id,url,title,description,icon_url,keywords,snippet
    FROM index_results ORDER BY id${maxRows > 0 ? ' LIMIT ?' : ''}`;
  const localRows = maxRows > 0 ? local.prepare(selectSql).all(maxRows) : local.prepare(selectSql).all();

  for (let offset = 0; offset < localRows.length; offset += batchSize) {
    const chunk = localRows.slice(offset, offset + batchSize);
    await remoteBatch(chunk.flatMap(statementsForRow));
    console.log(`Transferred ${Math.min(offset + chunk.length, localRows.length)}/${localRows.length} rows by url`);
  }

  if (localRows.length) {
    const placeholders = localRows.map(() => '?').join(',');
    const deleted = local.transaction(() =>
      local.prepare(`DELETE FROM index_results WHERE id IN (${placeholders})`).run(...localRows.map((row) => row.id)).changes,
    )();
    if (deleted !== localRows.length) {
      throw new Error(`Expected to delete ${localRows.length} local rows, deleted ${deleted}`);
    }
  }

  console.log(JSON.stringify({
    local_transferred: localRows.length,
    deleted_local: localRows.length,
    remote_mode: 'write-only',
    dedupe_key: 'url',
    fts_strategy: 'per-url delete+insert',
  }));
} finally {
  local.close();
  remote.close();
}
