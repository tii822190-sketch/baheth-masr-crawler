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

test('discovery follows listed and nested sitemaps, filters robots paths, and queues duplicate pages once', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-discovery-test-'));
  const dbPath = path.join(tempDir, 'crawler.sqlite');
  let siteUrl = '';
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`User-agent: BahethMasrDiscovery\nDisallow: /private\nSitemap: ${siteUrl}sitemap.xml\n`);
      return;
    }
    if (request.url === '/sitemap.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<sitemapindex><sitemap><loc>${siteUrl}map-a</loc></sitemap><sitemap><loc>${siteUrl}map-b</loc></sitemap></sitemapindex>`);
      return;
    }
    if (request.url === '/map-a') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<urlset><url><loc>${siteUrl}article</loc></url><url><loc>${siteUrl}private/never</loc></url></urlset>`);
      return;
    }
    if (request.url === '/map-b') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<urlset><url><loc>${siteUrl}article</loc></url><url><loc>${siteUrl}article?utm_source=duplicate</loc></url></urlset>`);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  siteUrl = `http://127.0.0.1:${server.address().port}/`;
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
        DISCOVERY_TIMEOUT_MS: '2000',
        DISCOVERY_MAX_PAGES_PER_SITE: '25',
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
    const queued = check.prepare('SELECT url FROM site_pages ORDER BY url').all().map((row) => row.url);
    const uniqueCount = check.prepare('SELECT COUNT(DISTINCT url) AS n FROM site_pages').get().n;
    check.close();
    assert.equal(result.status, 'completed');
    assert.ok(queued.includes(`${siteUrl}article`));
    assert.ok(!queued.some((url) => url.includes('/private/')));
    assert.equal(queued.length, uniqueCount);
    assert.ok(requested.includes('/map-a'));
    assert.ok(requested.includes('/map-b'));
    assert.ok(!requested.includes('/private/never'));
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('discovery follows a robots-declared nonstandard HTML sitemap and preserves government content routes and parameters', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-discovery-html-sitemap-'));
  const dbPath = path.join(tempDir, 'crawler.sqlite');
  let siteUrl = '';
  let otherPortUrl = '';
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`User-agent: BahethMasrDiscovery\nAllow: /\nSitemap: ${siteUrl}maps/current?revision=2\n`);
      return;
    }
    if (request.url === '/maps/current?revision=2') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body><a href="/service?id=1&amp;utm_source=x">خدمة 1</a><a href="/service?id=2">خدمة 2</a><a href="/category/news">أخبار الوزارة</a><a href="/pages/education">التعليم</a><a href="${otherPortUrl}">منفذ آخر</a></body></html>`);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  siteUrl = `http://127.0.0.1:${server.address().port}/`;
  otherPortUrl = `http://127.0.0.1:${Number(server.address().port) + 1}/service?id=foreign-port`;
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
  db.prepare('INSERT INTO sites (url,crawl_status) VALUES (?, ?)').run(siteUrl, 'not_pages');
  db.close();

  try {
    const child = spawn(process.execPath, ['tools/discovery-spider.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        CRAWLER_DB_PATH: dbPath,
        DISCOVERY_SITE_URL: siteUrl,
        DISCOVERY_TIMEOUT_MS: '2000',
        DISCOVERY_MAX_PAGES_PER_SITE: '25',
        DISCOVERY_MAX_SITEMAPS: '100',
        DISCOVERY_BROWSER_BUDGET_MS: '1000',
        DISCOVERY_SITEMAP_PROBE_TIMEOUT_MS: '1000',
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
    const queued = check.prepare('SELECT url FROM site_pages ORDER BY url').all().map((row) => row.url);
    check.close();
    assert.equal(result.status, 'completed');
    assert.ok(requested.includes('/maps/current?revision=2'));
    assert.ok(requested.indexOf('/maps/current?revision=2') < requested.indexOf('/sitemap.xml'));
    assert.ok(queued.includes(`${siteUrl}service?id=1`));
    assert.ok(queued.includes(`${siteUrl}service?id=2`));
    assert.ok(queued.includes(`${siteUrl}category/news`));
    assert.ok(queued.includes(`${siteUrl}pages/education`));
    assert.ok(!queued.includes(otherPortUrl));
    assert.ok(result.valid_sitemaps >= 1);
    assert.ok(result.sitemap_diagnostics.some((item) => item.outcome === 'failed' && item.reason === 'http_404'));
    assert.ok(result.sitemap_diagnostics.some((item) => item.outcome === 'parsed' && item.format === 'html'));
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
