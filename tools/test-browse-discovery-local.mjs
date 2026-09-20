import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-browse-test-'));
const dbPath = path.join(tempDir, 'crawler.sqlite');
const db = new Database(dbPath);
db.exec("CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT UNIQUE NOT NULL,crawl_status TEXT NOT NULL,discovery_cursor TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE site_pages (id INTEGER PRIMARY KEY AUTOINCREMENT,site_id INTEGER NOT NULL,url TEXT UNIQUE NOT NULL,crawl_status TEXT NOT NULL DEFAULT 'pending',crawl_attempts INTEGER NOT NULL DEFAULT 0); CREATE TABLE index_results (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT UNIQUE NOT NULL,title TEXT,description TEXT,icon_url TEXT,keywords TEXT,snippet TEXT);");
db.close();
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const html = req.url === '/'
    ? '<a href="/first">first</a><a href="/قسم-عربي">قسم عربي</a><a href="/contact">contact</a><a href="/privacy">privacy</a>'
    : req.url === '/%D9%82%D8%B3%D9%85-%D8%B9%D8%B1%D8%A8%D9%8A'
      ? '<a href="/inside-arabic">inside Arabic</a><a href="/privacy">privacy</a>'
      : '<a href="/should-not-be-opened">bad</a>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<html><body>${html}</body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${server.address().port}/`;
const seeded = new Database(dbPath);
seeded.prepare("INSERT INTO sites (url,crawl_status) VALUES (?, 'not_pages')").run(siteUrl);
seeded.close();
try {
  await new Promise((resolve, reject) => {
    const child = spawn('node', ['tools/browse-discovery-spider.mjs'], { cwd: root, env: { ...process.env, CRAWLER_DB_PATH: dbPath, BROWSE_MAX_PAGES: '10', BROWSE_BROWSER_BUDGET_MS: '1000' }, stdio: 'inherit' });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  const checked = new Database(dbPath, { readonly: true });
  const site = checked.prepare('SELECT crawl_status,discovery_cursor FROM sites').get();
  const pages = checked.prepare('SELECT url FROM site_pages ORDER BY id').all().map((row) => row.url);
  checked.close();
  const pageRequests = requests.filter((url) => url !== '/favicon.ico');
  if (site.crawl_status !== 'completed' || pages.length !== 4 || pages.some((url) => /contact|privacy|should-not/.test(url)) || pageRequests.length !== 2 || pageRequests[0] !== '/' || pageRequests[1] !== '/%D9%82%D8%B3%D9%85-%D8%B9%D8%B1%D8%A8%D9%8A') throw new Error(JSON.stringify({ site, pages, requests }));
  console.log(JSON.stringify({ ok: true, pages, requests, pages_visited: JSON.parse(site.discovery_cursor).visited }, null, 2));
} finally { server.close(); fs.rmSync(tempDir, { recursive: true, force: true }); }
