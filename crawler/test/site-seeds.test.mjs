import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(new URL('../..', import.meta.url).pathname);

async function runLoader(dbPath, siteUrl = '') {
  const child = spawn(process.execPath, ['tools/load-site-seeds.mjs'], {
    cwd: root,
    env: { ...process.env, CRAWLER_DB_PATH: dbPath, DISCOVERY_SITE_URL: siteUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr || stdout);
  return JSON.parse(stdout);
}

test('site seed loader adds only configured sites and is idempotent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-site-seeds-'));
  const dbPath = path.join(tempDir, 'crawler.sqlite');
  try {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL UNIQUE,crawl_status TEXT NOT NULL DEFAULT 'pending')`);
    db.close();

    const first = await runLoader(dbPath);
    assert.deepEqual({ seeds: first.seeds, inserted: first.inserted, existing: first.existing }, { seeds: 2, inserted: 2, existing: 0 });
    const second = await runLoader(dbPath);
    assert.deepEqual({ seeds: second.seeds, inserted: second.inserted, existing: second.existing }, { seeds: 2, inserted: 0, existing: 2 });

    const check = new Database(dbPath, { readonly: true });
    const rows = check.prepare('SELECT url,crawl_status FROM sites ORDER BY url').all();
    check.close();
    assert.deepEqual(rows, [
      { url: 'https://misrquran.gov.eg/', crawl_status: 'pending' },
      { url: 'https://quran.com/ar', crawl_status: 'pending' },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('manual site_url input is queued once by the seed loader', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baheth-site-seeds-manual-'));
  const dbPath = path.join(tempDir, 'crawler.sqlite');
  try {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL UNIQUE,crawl_status TEXT NOT NULL DEFAULT 'pending')`);
    db.close();
    const result = await runLoader(dbPath, 'https://quran.com/');
    assert.equal(result.inserted, 2);
    const check = new Database(dbPath, { readonly: true });
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sites WHERE url='https://quran.com/ar'").get().count, 1);
    check.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
