import Database from 'better-sqlite3';
const db = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/crawler.sqlite', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
if (tables.join(',') !== 'index_results,site_pages,sites') throw new Error(`Unexpected tables: ${tables.join(',')}`);
if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity check failed');
console.log(JSON.stringify({ tables, index_results: db.prepare('SELECT COUNT(*) AS count FROM index_results').get().count, queued_pages: db.prepare('SELECT COUNT(*) AS count FROM site_pages').get().count }, null, 2));
db.close();
