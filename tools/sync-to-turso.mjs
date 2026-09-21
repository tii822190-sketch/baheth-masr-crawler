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
const requiredPageColumns = ['id', 'url', 'title', 'description', 'icon_url', 'keywords', 'snippet', 'created_at', 'updated_at'];
const requiredFtsColumns = ['page_id', 'url', 'title', 'description', 'keywords', 'snippet'];

if (!tursoUrl || !tursoAuthToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
const local = new Database(localPath);
const remote = createClient({ url: tursoUrl, authToken: tursoAuthToken });
const quote = (value) => `"${value.replaceAll('"', '""')}"`;

async function exists(name) {
  const result = await remote.execute({ sql: "SELECT name FROM sqlite_master WHERE name=?", args: [name] });
  return result.rows.length > 0;
}
async function columns(name) {
  const result = await remote.execute({ sql: `PRAGMA table_info(${quote(name)})`, args: [] });
  return result.rows.map((row) => String(row.name));
}
async function rebuildFts() {
  await remote.batch([
    { sql: `DROP TABLE IF EXISTS ${quote(ftsTable)}`, args: [] },
    { sql: `CREATE VIRTUAL TABLE ${quote(ftsTable)} USING fts5(
      page_id UNINDEXED,
      url UNINDEXED,
      title,
      description,
      keywords,
      snippet,
      tokenize='unicode61 remove_diacritics 2'
    )`, args: [] },
    { sql: `INSERT INTO ${quote(ftsTable)} (page_id,url,title,description,keywords,snippet)
      SELECT id,url,title,description,keywords,snippet FROM ${quote(pagesTable)}`, args: [] },
  ], 'write');
}
async function ensureExternalSchema() {
  if (!(await exists(pagesTable))) throw new Error(`Required Turso table is missing: ${pagesTable}`);
  const pageColumns = await columns(pagesTable);
  const legacyTextColumn = pageColumns.includes('snippet') ? 'snippet' : 'content';
  if (pageColumns.join(',') !== requiredPageColumns.join(',')) {
    await remote.batch([
      { sql: `CREATE TABLE search_pages_migration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        icon_url TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '',
        snippet TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`, args: [] },
      { sql: `INSERT INTO search_pages_migration (id,url,title,description,icon_url,keywords,snippet,created_at,updated_at)
        SELECT id,url,title,description,icon_url,keywords,COALESCE(${quote(legacyTextColumn)},''),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
        FROM ${quote(pagesTable)}`, args: [] },
      { sql: `DROP TABLE ${quote(pagesTable)}`, args: [] },
      { sql: 'ALTER TABLE search_pages_migration RENAME TO search_pages', args: [] },
    ], 'write');
  }
  const ftsColumns = (await exists(ftsTable)) ? await columns(ftsTable) : [];
  if (ftsColumns.join(',') !== requiredFtsColumns.join(',')) await rebuildFts();
}
async function upsertPage(row) {
  const content = row.snippet || row.description || '';
  await remote.execute({
    sql: `INSERT INTO ${quote(pagesTable)}
      (url,title,description,icon_url,keywords,snippet,created_at,updated_at)
      VALUES (?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP),COALESCE(?,CURRENT_TIMESTAMP))
      ON CONFLICT(url) DO UPDATE SET
        title=excluded.title, description=excluded.description, icon_url=excluded.icon_url,
        keywords=excluded.keywords, snippet=excluded.snippet, updated_at=excluded.updated_at`,
    args: [row.url, row.title || '', row.description || '', row.icon_url || '', row.keywords || '', content, row.created_at, row.updated_at],
  });
  const page = await remote.execute({ sql: `SELECT id,url,title,description,keywords,snippet FROM ${quote(pagesTable)} WHERE url=?`, args: [row.url] });
  const item = page.rows[0];
  if (!item) throw new Error(`Could not resolve search_pages row for ${row.url}`);
  await remote.execute({ sql: `DELETE FROM ${quote(ftsTable)} WHERE page_id=?`, args: [item.id] });
  await remote.execute({ sql: `INSERT INTO ${quote(ftsTable)} (page_id,url,title,description,keywords,snippet) VALUES (?,?,?,?,?,?)`, args: [item.id, item.url, item.title, item.description, item.keywords, item.snippet] });
}

try {
  await ensureExternalSchema();
  const legacyRows = (await exists(legacyTable))
    ? (await remote.execute(`SELECT url,title,description,icon_url,keywords,snippet,created_at,updated_at FROM ${quote(legacyTable)}`)).rows
    : [];
  const selectSql = `SELECT id,url,title,description,icon_url,keywords,snippet,created_at,updated_at FROM index_results ORDER BY id ${maxRows > 0 ? 'LIMIT ?' : ''}`;
  const localRows = maxRows > 0 ? local.prepare(selectSql).all(maxRows) : local.prepare(selectSql).all();
  const allRows = [...legacyRows, ...localRows];
  for (let offset = 0; offset < allRows.length; offset += batchSize) {
    for (const row of allRows.slice(offset, offset + batchSize)) await upsertPage(row);
    console.log(`Transferred ${Math.min(offset + batchSize, allRows.length)}/${allRows.length} to ${pagesTable} + ${ftsTable}`);
  }
  if (await exists(legacyTable)) await remote.execute(`DROP TABLE ${quote(legacyTable)}`);
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
