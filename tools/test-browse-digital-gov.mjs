import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const siteUrl = process.env.TEST_SITE_URL || 'https://digital.gov.eg';
const maxPages = process.env.TEST_MAX_PAGES || '10000';
const pageTimeoutMs = process.env.TEST_PAGE_TIMEOUT_MS || '30000';
const browserBudgetMs = process.env.TEST_BROWSER_BUDGET_MS || '10000';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-digital-gov-test-'));
const dbPath = path.join(tempDir, 'crawler.sqlite');
const db = new Database(dbPath);
db.exec("CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT UNIQUE NOT NULL,crawl_status TEXT NOT NULL,discovery_cursor TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE site_pages (id INTEGER PRIMARY KEY AUTOINCREMENT,site_id INTEGER NOT NULL,url TEXT UNIQUE NOT NULL,crawl_status TEXT NOT NULL DEFAULT 'pending',crawl_attempts INTEGER NOT NULL DEFAULT 0); CREATE TABLE index_results (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT UNIQUE NOT NULL,title TEXT,description TEXT,icon_url TEXT,keywords TEXT,snippet TEXT);");
db.prepare("INSERT INTO sites (url,crawl_status) VALUES (?, 'not_pages')").run(siteUrl);
db.close();

try {
  await new Promise((resolve, reject) => {
    const child = spawn('node', ['tools/browse-discovery-spider.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        CRAWLER_DB_PATH: dbPath,
        BROWSE_MAX_PAGES: maxPages,
        BROWSE_PAGE_TIMEOUT_MS: pageTimeoutMs,
        BROWSE_BROWSER_BUDGET_MS: browserBudgetMs,
      },
      stdio: 'inherit',
    });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`spider exited with code ${code}`)));
  });

  const checked = new Database(dbPath, { readonly: true });
  const site = checked.prepare('SELECT url,crawl_status,discovery_cursor FROM sites').get();
  const pages = checked.prepare('SELECT url,crawl_status FROM site_pages ORDER BY id').all();
  checked.close();
  console.log(JSON.stringify({
    ok: true,
    site: site.url,
    status: site.crawl_status,
    pages_visited: JSON.parse(site.discovery_cursor || '{}').visited ?? 0,
    discovered_count: pages.length,
    discovered_links: pages.map((row) => row.url),
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
