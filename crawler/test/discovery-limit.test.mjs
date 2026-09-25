import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';

const root = path.resolve(new URL('../..', import.meta.url).pathname);

test('discovery hard-caps at 50,000 unique pages per site and stores a resume cursor', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-discovery-cap-'));
  const dbPath = path.join(tempDir, 'crawler.sqlite');
  let siteUrl = '';
  const sitemap = [];
  for (let i = 1; i <= 50020; i += 1) sitemap.push(`<url><loc>${siteUrl}article/${i}</loc></url>`);
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`);
      return;
    }
    if (request.url === '/sitemap.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<urlset>${sitemap.join('')}</urlset>`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<title>Test</title><main>Arabic crawler test</main>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  siteUrl = `http://127.0.0.1:${server.address().port}/`;
  for (let i = 0; i < sitemap.length; i += 1) sitemap[i] = `<url><loc>${siteUrl}article/${i + 1}</loc></url>`;

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      crawl_status TEXT NOT NULL DEFAULT 'pending',
      discovery_cursor TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE site_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      url TEXT NOT NULL UNIQUE,
      crawl_status TEXT NOT NULL DEFAULT 'pending',
      crawl_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO sites (url) VALUES (?)').run(siteUrl);
  db.close();

  try {
    const child = spawn(process.execPath, ['tools/discovery-spider.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        CRAWLER_DB_PATH: dbPath,
        DISCOVERY_SITE_URL: siteUrl,
        DISCOVERY_MAX_PAGES_PER_SITE: '50000',
        DISCOVERY_TIMEOUT_MS: '5000',
        DISCOVERY_MAX_SITEMAPS: '100',
        DISCOVERY_BROWSER_BUDGET_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr || stdout);
    const result = JSON.parse(stdout);
    const check = new Database(dbPath, { readonly: true });
    const count = check.prepare('SELECT COUNT(*) AS count FROM site_pages').get().count;
    const site = check.prepare('SELECT crawl_status,discovery_cursor FROM sites WHERE url=?').get(siteUrl);
    const unique = check.prepare('SELECT COUNT(DISTINCT url) AS count FROM site_pages').get().count;
    check.close();
    assert.equal(result.pages_total, 50000);
    assert.equal(result.max_pages, 50000);
    assert.equal(result.status, 'incomplete');
    assert.equal(count, 50000);
    assert.equal(unique, 50000);
    assert.equal(site.crawl_status, 'incomplete');
    assert.ok(site.discovery_cursor);
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
