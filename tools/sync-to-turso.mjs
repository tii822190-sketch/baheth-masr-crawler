import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';

const localPath = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const pagesTable = 'search_pages';
const ftsTable = 'search_pages_fts';
const legacyTable = 'index_results';
const batchSize = Math.max(1, Number(process.env.TURSO_BATCH_SIZE || 500));
const maxRows = Math.max(0, Number(process.env.TURSO_MAX_ROWS || 0));
const retryCount = Math.max(0, Number(process.env.TURSO_RETRIES || 5));
const requiredPageColumns = ['url', 'title', 'description', 'icon_url', 'snippet', 'keywords'];
const requiredFtsColumns = ['url', 'title', 'description', 'icon_url', 'snippet', 'keywords'];

if (!tursoUrl || !tursoAuthToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
const local = new Database(localPath);
const remote = createClient({ url: tursoUrl, authToken: tursoAuthToken });
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function remoteExecute(statement) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await remote.execute(statement); }
    catch (error) {
      if (attempt >= retryCount) throw error;
      const delay = Math.min(30000, 1000 * (2 ** attempt));
      console.warn(`Turso request failed; retrying in ${delay}ms (${attempt + 1}/${retryCount})`);
      await sleep(delay);
    }
  }
}
async function remoteBatch(statements, mode = 'write') {
  for (let attempt = 0; ; attempt += 1) {
    try { return await remote.batch(statements, mode); }
    catch (error) {
      if (attempt >= retryCount) throw error;
      const delay = Math.min(30000, 1000 * (2 ** attempt));
      console.warn(`Turso batch failed; retrying in ${delay}ms (${attempt + 1}/${retryCount})`);
      await sleep(delay);
    }
  }
}

async function exists(name) {
  const result = await remoteExecute({ sql: "SELECT name FROM sqlite_master WHERE name=?", args: [name] });
  return result.rows.length > 0;
}
async function columns(name) {
  const result = await remoteExecute({ sql: `PRAGMA table_info(${quote(name)})`, args: [] });
  return result.rows.map((row) => String(row.name));
}
async function rebuildFts() {
  await remoteBatch([
    { sql: `DROP TABLE IF EXISTS ${quote(ftsTable)}`, args: [] },
    { sql: `CREATE VIRTUAL TABLE ${quote(ftsTable)} USING fts5(
      url UNINDEXED,
      title,
      description,
      icon_url UNINDEXED,
      snippet,
      keywords,
      tokenize='unicode61 remove_diacritics 2'
    )`, args: [] },
    { sql: `INSERT INTO ${quote(ftsTable)} (url,title,description,icon_url,snippet,keywords)
      SELECT url,title,description,icon_url,snippet,keywords FROM ${quote(pagesTable)}`, args: [] },
  ], 'write');
}
async function refreshFts() {
  await remoteBatch([
    { sql: `DELETE FROM ${quote(ftsTable)}`, args: [] },
    { sql: `INSERT INTO ${quote(ftsTable)} (url,title,description,icon_url,snippet,keywords)
      SELECT url,title,description,icon_url,snippet,keywords FROM ${quote(pagesTable)}`, args: [] },
  ], 'write');
}
async function ensureExternalSchema() {
  if (!(await exists(pagesTable))) throw new Error(`Required Turso table is missing: ${pagesTable}`);
  const pageColumns = await columns(pagesTable);
  const textColumn = pageColumns.includes('snippet') ? 'snippet' : 'content';
  if (pageColumns.join(',') !== requiredPageColumns.join(',')) {
    await remoteBatch([
      { sql: `CREATE TABLE search_pages_migration (
        url TEXT NOT NULL PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        icon_url TEXT NOT NULL DEFAULT '',
        snippet TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT ''
      )`, args: [] },
      { sql: `INSERT OR REPLACE INTO search_pages_migration (url,title,description,icon_url,snippet,keywords)
        SELECT url,title,description,icon_url,COALESCE(${quote(textColumn)},''),keywords FROM ${quote(pagesTable)}`, args: [] },
      { sql: `DROP TABLE ${quote(pagesTable)}`, args: [] },
      { sql: 'ALTER TABLE search_pages_migration RENAME TO search_pages', args: [] },
    ], 'write');
  }
  const ftsColumns = (await exists(ftsTable)) ? await columns(ftsTable) : [];
  if (ftsColumns.join(',') !== requiredFtsColumns.join(',')) await rebuildFts();
}
async function upsertPages(rows) {
  await remoteBatch(rows.map((row) => ({
    sql: `INSERT INTO ${quote(pagesTable)} (url,title,description,icon_url,snippet,keywords)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET
        title=excluded.title, description=excluded.description, icon_url=excluded.icon_url,
        snippet=excluded.snippet, keywords=excluded.keywords`,
    args: [row.url, row.title || '', row.description || '', row.icon_url || '', row.snippet || row.content || '', row.keywords || ''],
  })), 'write');
}

try {
  await ensureExternalSchema();
  const legacyRows = (await exists(legacyTable))
    ? (await remoteExecute(`SELECT url,title,description,icon_url,keywords,snippet FROM ${quote(legacyTable)}`)).rows
    : [];
  const selectSql = `SELECT id,url,title,description,icon_url,keywords,snippet FROM index_results ORDER BY id ${maxRows > 0 ? 'LIMIT ?' : ''}`;
  const localRows = maxRows > 0 ? local.prepare(selectSql).all(maxRows) : local.prepare(selectSql).all();
  const allRows = [...legacyRows, ...localRows];
  for (let offset = 0; offset < allRows.length; offset += batchSize) {
    await upsertPages(allRows.slice(offset, offset + batchSize));
    console.log(`Transferred ${Math.min(offset + batchSize, allRows.length)}/${allRows.length} to ${pagesTable} + ${ftsTable}`);
  }
  await refreshFts();
  if (await exists(legacyTable)) await remoteExecute(`DROP TABLE ${quote(legacyTable)}`);
  if (localRows.length) {
    const placeholders = localRows.map(() => '?').join(',');
    const deleted = local.transaction(() => local.prepare(`DELETE FROM index_results WHERE id IN (${placeholders})`).run(...localRows.map((row) => row.id)).changes)();
    if (deleted !== localRows.length) throw new Error(`Expected to delete ${localRows.length} local rows, deleted ${deleted}`);
  }
  console.log(JSON.stringify({ legacy_transferred: legacyRows.length, local_transferred: localRows.length, deleted_local: localRows.length, pages_table: pagesTable, fts_table: ftsTable, legacy_table_removed: true }));
} finally {
  local.close();
  remote.close();
}
