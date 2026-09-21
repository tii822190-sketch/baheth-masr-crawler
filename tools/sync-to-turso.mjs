import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';

const localPath = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const externalTable = process.env.TURSO_RESULTS_TABLE || 'index_results';
const batchSize = Math.max(1, Number(process.env.TURSO_BATCH_SIZE || 500));

if (!tursoUrl || !tursoAuthToken) {
  throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(externalTable)) {
  throw new Error('TURSO_RESULTS_TABLE must be a simple SQL identifier');
}

const local = new Database(localPath);
const remote = createClient({ url: tursoUrl, authToken: tursoAuthToken });

try {
  const rows = local.prepare(`
    SELECT id, url, title, description, icon_url, keywords, snippet, created_at, updated_at
    FROM index_results
    ORDER BY id
  `).all();

  if (!rows.length) {
    console.log(JSON.stringify({ transferred: 0, deleted: 0, message: 'No local index results to transfer' }));
    process.exit(0);
  }

  await remote.execute(`
    CREATE TABLE IF NOT EXISTS ${externalTable} (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      icon_url TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await remote.execute(`CREATE INDEX IF NOT EXISTS idx_${externalTable}_url ON ${externalTable}(url)`);

  const statements = rows.map((row) => ({
    sql: `
      INSERT INTO ${externalTable}
        (id, url, title, description, icon_url, keywords, snippet, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        title=excluded.title,
        description=excluded.description,
        icon_url=excluded.icon_url,
        keywords=excluded.keywords,
        snippet=excluded.snippet,
        updated_at=excluded.updated_at
    `,
    args: [row.id, row.url, row.title, row.description, row.icon_url, row.keywords, row.snippet, row.created_at, row.updated_at],
  }));

  for (let offset = 0; offset < statements.length; offset += batchSize) {
    await remote.batch(statements.slice(offset, offset + batchSize), 'write');
    console.log(`Transferred ${Math.min(offset + batchSize, statements.length)}/${statements.length}`);
  }

  // Delete only after every remote write has completed successfully.
  const deleted = local.transaction(() => local.prepare('DELETE FROM index_results').run().changes)();
  if (deleted !== rows.length) {
    throw new Error(`Expected to delete ${rows.length} local rows, deleted ${deleted}`);
  }
  console.log(JSON.stringify({ transferred: rows.length, deleted, external_table: externalTable }));
} finally {
  local.close();
  remote.close();
}
