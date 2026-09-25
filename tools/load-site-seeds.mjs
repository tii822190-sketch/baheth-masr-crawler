import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function canonicalize(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/index\.(?:html?|php)$/i, '/') || '/';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    if (url.hostname === 'quran.com' && url.pathname === '/') url.pathname = '/ar';
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return ''; }
}

const dbPath = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const seedPath = process.env.CRAWLER_SITE_SEED_FILE || 'db/site-seed-urls.txt';
const db = new Database(dbPath);
try {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (!tables.has('sites')) throw new Error(`Database ${dbPath} has no sites table; initialize it before loading seeds.`);
  const urls = [...new Set([...fs.readFileSync(path.resolve(seedPath), 'utf8').split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(canonicalize)
    .filter(Boolean), canonicalize(process.env.DISCOVERY_SITE_URL || '')].filter(Boolean))];
  const insert = db.prepare("INSERT OR IGNORE INTO sites (url,crawl_status) VALUES (?,'pending')");
  const result = db.transaction((items) => items.reduce((count, url) => count + insert.run(url).changes, 0))(urls);
  console.log(JSON.stringify({ db_path: dbPath, seed_file: seedPath, seeds: urls.length, inserted: result, existing: urls.length - result }, null, 2));
} finally {
  db.close();
}
