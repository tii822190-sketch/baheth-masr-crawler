import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';

const localPath = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const pagesTable = process.env.TURSO_PAGES_TABLE || 'search_pages';
const ftsTable = process.env.TURSO_FTS_TABLE || 'search_pages_fts';
const batchSize = Math.max(1, Number(process.env.TURSO_BATCH_SIZE || 500));
const maxRows = Math.max(0, Number(process.env.TURSO_MAX_ROWS || 0));

if (!tursoUrl || !tursoAuthToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
for (const [label, value] of [['TURSO_PAGES_TABLE', pagesTable], ['TURSO_FTS_TABLE', ftsTable]]) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${label} must be a simple SQL identifier`);
}

const local = new Database(localPath);
const remote = createClient({ url: tursoUrl, authToken: tursoAuthToken });
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const pages = quote(pagesTable);
const fts = quote(ftsTable);

try {
  const tableCheck = await remote.execute({
    sql: "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name IN (?, ?)",
    args: [pagesTable, ftsTable],
  });
  const found = new Set(tableCheck.rows.map((row) => String(row.name)));
  if (!found.has(pagesTable) || !found.has(ftsTable)) {
    throw new Error(`Required Turso tables are missing: ${[pagesTable, ftsTable].filter((name) => !found.has(name)).join(', ')}`);
  }

  const selectSql = `
    SELECT id, url, title, description, icon_url, keywords, snippet, updated_at
    FROM index_results
    ORDER BY id
    ${maxRows > 0 ? 'LIMIT ?' : ''}
  `;
  const rows = maxRows > 0 ? local.prepare(selectSql).all(maxRows) : local.prepare(selectSql).all();
  if (!rows.length) {
    console.log(JSON.stringify({ transferred: 0, deleted: 0, message: 'No local index results to transfer' }));
    process.exit(0);
  }

  const writeRow = async (row) => {
    const content = row.snippet || row.description || '';
    const searchText = [row.title, row.description, content, row.keywords].filter(Boolean).join(' ').trim();
    await remote.execute({
      sql: `
        INSERT INTO ${pages}
          (url, title, description, content, keywords, icon_url, category, subcategory_1, subcategory_2, subcategory_3, search_text, priority, quality, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '', '', '', '', ?, 70, 0, COALESCE(?, CURRENT_TIMESTAMP))
        ON CONFLICT(url) DO UPDATE SET
          title=excluded.title,
          description=excluded.description,
          content=excluded.content,
          keywords=excluded.keywords,
          icon_url=excluded.icon_url,
          search_text=excluded.search_text,
          updated_at=excluded.updated_at
      `,
      args: [row.url, row.title, row.description, content, row.keywords, row.icon_url, searchText, row.updated_at],
    });
    const page = await remote.execute({ sql: `SELECT id FROM ${pages} WHERE url=?`, args: [row.url] });
    const pageId = page.rows[0]?.id;
    if (pageId === undefined || pageId === null) throw new Error(`Could not resolve search_pages id for ${row.url}`);
    await remote.execute({ sql: `DELETE FROM ${fts} WHERE page_id=?`, args: [pageId] });
    await remote.execute({
      sql: `
        INSERT INTO ${fts}
          (page_id, url, title, description, content, keywords, icon_url, category, subcategory_1, subcategory_2, subcategory_3, search_text, priority, quality)
        SELECT id, url, title, description, content, keywords, icon_url, category, subcategory_1, subcategory_2, subcategory_3, search_text, priority, quality
        FROM ${pages} WHERE id=?
      `,
      args: [pageId],
    });
  };

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    for (const row of rows.slice(offset, offset + batchSize)) await writeRow(row);
    console.log(`Transferred ${Math.min(offset + batchSize, rows.length)}/${rows.length} to ${pagesTable} + ${ftsTable}`);
  }

  const placeholders = rows.map(() => '?').join(',');
  const deleted = local.transaction(() => local.prepare(`DELETE FROM index_results WHERE id IN (${placeholders})`).run(...rows.map((row) => row.id)).changes)();
  if (deleted !== rows.length) throw new Error(`Expected to delete ${rows.length} local rows, deleted ${deleted}`);
  console.log(JSON.stringify({ transferred: rows.length, deleted, pages_table: pagesTable, fts_table: ftsTable }));
} finally {
  local.close();
  remote.close();
}
