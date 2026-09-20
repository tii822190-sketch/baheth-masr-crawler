import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-four-sites-'));
const dbPath = path.join(tempDir, 'crawler.sqlite');
const requests = [];
const pages = {
  '/static/': '<a href="/static/a">أخبار</a><a href="/static/a#duplicate">مكرر</a><a href="/static/b">خدمات</a><a href="/static/contact">تواصل</a>',
  '/static/a': '<a href="/static/detail">تفاصيل</a>',
  '/static/b': '<a href="/static/detail">تفاصيل مكررة</a>',
  '/arabic/': '<a href="/arabic/قسم-عربي">قسم عربي</a><a href="/arabic/en">English</a>',
  '/arabic/قسم-عربي': '<a href="/arabic/inside">داخل الصفحة العربية</a><a href="/arabic/inside#x">مكرر</a>',
  '/duplicate/': '<a href="/duplicate/same">واحد</a><a href="/duplicate/same?utm_source=x">اثنان</a><a href="/duplicate/same#hash">ثلاثة</a>',
};
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/error' || req.url.startsWith('/error/')) {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<h1>temporarily unavailable</h1>');
    return;
  }
  const rawKey = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const key = pages[rawKey] ? rawKey : `${rawKey}/`;
  const body = pages[key] || '<p>child page</p>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<html><body>${body}</body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const db = new Database(dbPath);
db.exec("CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT UNIQUE NOT NULL,crawl_status TEXT NOT NULL,discovery_cursor TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE site_pages (id INTEGER PRIMARY KEY AUTOINCREMENT,site_id INTEGER NOT NULL,url TEXT UNIQUE NOT NULL,crawl_status TEXT NOT NULL DEFAULT 'pending',crawl_attempts INTEGER NOT NULL DEFAULT 0); CREATE TABLE index_results (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT UNIQUE NOT NULL,title TEXT,description TEXT,icon_url TEXT,keywords TEXT,snippet TEXT);");
for (const prefix of ['static', 'arabic', 'duplicate', 'error']) db.prepare("INSERT INTO sites (url,crawl_status) VALUES (?, 'not_pages')").run(`${base}/${prefix}/`);
db.close();

function runSpider() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['tools/browse-discovery-spider.mjs'], { cwd: root, env: { ...process.env, CRAWLER_DB_PATH: dbPath, BROWSE_MAX_PAGES: '50', BROWSE_PAGE_TIMEOUT_MS: '5000', BROWSE_BROWSER_BUDGET_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (x) => { stdout += x; }); child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}
try {
  const runs = [];
  for (let i = 0; i < 5; i += 1) runs.push(await runSpider());
  const checked = new Database(dbPath, { readonly: true });
  const sites = checked.prepare('SELECT url,crawl_status,discovery_cursor FROM sites ORDER BY id').all();
  const rows = checked.prepare('SELECT site_id,url FROM site_pages ORDER BY site_id,id').all();
  checked.close();
  const bySite = Object.groupBy(rows, (row) => row.site_id);
  const errorSite = sites.find((site) => site.url.endsWith('/error/'));
  const errorRuns = runs.filter((run) => run.stderr.includes('homepage_unavailable')).length;
  const duplicateUrls = rows.length - new Set(rows.map((row) => `${row.site_id}:${row.url}`)).size;
  const errorAttempts = runs.filter((run) => run.stderr.includes('homepage_unavailable')).length;
  const noSiteAfterError = runs[4]?.stdout.includes('no_not_pages_site');
  if (sites.some((site) => site.crawl_status === 'processing') || !errorSite || errorSite.crawl_status !== 'error' || errorAttempts !== 1 || !noSiteAfterError || duplicateUrls !== 0 || bySite[1]?.some((row) => row.url.includes('contact')) || !bySite[2]?.some((row) => row.url.includes('/inside'))) {
    throw new Error(JSON.stringify({ sites, rows, runs, requests }));
  }
  console.log(JSON.stringify({ ok: true, sites: sites.map(({ url, crawl_status }) => ({ url, crawl_status })), links_by_site: bySite, duplicate_urls: duplicateUrls, terminal_error_attempts: errorAttempts, requests }, null, 2));
} finally {
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
