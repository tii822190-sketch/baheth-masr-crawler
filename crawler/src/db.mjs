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

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(name) {
  return tableExists(name) ? db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name) : [];
}
function createCoreTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      crawl_status TEXT NOT NULL DEFAULT 'pending',
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
}

export function initDb() {
  db.pragma('foreign_keys = OFF');
  createCoreTables();
  if (tableExists('pages_queue')) {
    db.exec(`INSERT OR IGNORE INTO site_pages (site_id,url,crawl_status,crawl_attempts)
      SELECT site_id,url,CASE WHEN indexed=1 THEN 'crawled' ELSE 'pending' END,0 FROM pages_queue`);
    db.exec('DROP TABLE pages_queue');
  }
  for (const table of ['crawl_quarantine','crawl_review_items','crawl_results','crawl_discoveries','crawl_observations','crawl_targets','crawl_runs','discovery_sitemap_cursor','discovery_queue']) {
    if (tableExists(table)) db.exec(`DROP TABLE ${table}`);
  }
  db.pragma('foreign_keys = ON');
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
