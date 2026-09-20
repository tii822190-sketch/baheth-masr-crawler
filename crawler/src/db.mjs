import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const dbDir = path.join(root, 'db');
fs.mkdirSync(dbDir, { recursive: true });
const inputPath = process.env.CRAWLER_INPUT_DB_PATH || path.join(dbDir, 'crawler.sqlite');
export const db = new Database(inputPath);
export const resultsDb = db;
db.pragma('foreign_keys = ON');

function columns(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name);
}
function createCoreTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      crawl_status TEXT NOT NULL DEFAULT 'pending',
      discovery_cursor TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS site_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      url TEXT NOT NULL UNIQUE,
      crawl_status TEXT NOT NULL DEFAULT 'pending',
      crawl_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS index_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      icon_url TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_site_pages_status ON site_pages(crawl_status,id);
    CREATE INDEX IF NOT EXISTS idx_site_pages_site ON site_pages(site_id,id);
    CREATE INDEX IF NOT EXISTS idx_index_results_url ON index_results(url);
  `);
  if (!columns('sites').includes('discovery_cursor')) db.exec('ALTER TABLE sites ADD COLUMN discovery_cursor TEXT');
}

function ensureSiteStatusConstraint() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sites'").get()?.sql || '';
  if (schema.includes("'not_pages'") && schema.includes("'error'")) return;

  // Existing SQLite tables keep their original CHECK constraint after a
  // CREATE IF NOT EXISTS. Rebuild both related tables so old databases can
  // accept the backup spider's terminal statuses without breaking the FK.
  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE sites_data_backup AS SELECT * FROM sites');
    db.exec('CREATE TABLE site_pages_data_backup AS SELECT * FROM site_pages');
    db.exec('DROP TABLE site_pages');
    db.exec('ALTER TABLE sites RENAME TO sites_old_status_constraint');
    db.exec(`CREATE TABLE sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      crawl_status TEXT NOT NULL DEFAULT 'pending' CHECK (crawl_status IN ('pending','not_pages','processing','completed','incomplete','failed','error')),
      discovery_cursor TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('INSERT INTO sites (id,url,crawl_status,discovery_cursor,created_at,updated_at) SELECT id,url,crawl_status,discovery_cursor,created_at,updated_at FROM sites_data_backup');
    db.exec('DROP TABLE sites_old_status_constraint');
    db.exec(`CREATE TABLE site_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      url TEXT NOT NULL UNIQUE,
      crawl_status TEXT NOT NULL DEFAULT 'pending',
      crawl_attempts INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec('INSERT INTO site_pages (id,site_id,url,crawl_status,crawl_attempts) SELECT id,site_id,url,crawl_status,crawl_attempts FROM site_pages_data_backup');
    db.exec('DROP TABLE sites_data_backup');
    db.exec('DROP TABLE site_pages_data_backup');
    db.exec('CREATE INDEX IF NOT EXISTS idx_site_pages_status ON site_pages(crawl_status,id); CREATE INDEX IF NOT EXISTS idx_site_pages_site ON site_pages(site_id,id)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export function initDb() {
  createCoreTables();
  ensureSiteStatusConstraint();
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`Database integrity check failed: ${integrity}`);
}

export function canonicalize(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.username = '';
    u.password = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    u.pathname = u.pathname.replace(/\/index\.(html?|php)$/i, '/') || '/';
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    [...u.searchParams.keys()].filter((key) => /^(utm_|fbclid|gclid)/i.test(key)).forEach((key) => u.searchParams.delete(key));
    return u.toString();
  } catch {
    return '';
  }
}
