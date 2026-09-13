import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const dbPath = process.env.CRAWLER_DB_PATH || path.join(root, 'db', 'staging.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

export function initDb() {
  const migration = fs.readFileSync(path.join(root, 'migrations/001_crawler_staging.sql'), 'utf8');
  db.exec(migration);
  const seed = fs.readFileSync(path.join(root, 'db/seed-staging.sql'), 'utf8');
  db.exec(seed);
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
    [...u.searchParams.keys()].filter(k => /^(utm_|fbclid|gclid)/i.test(k)).forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch { return ''; }
}
