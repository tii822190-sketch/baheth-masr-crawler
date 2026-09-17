import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { extractHtml } from '../crawler/src/extract.mjs';
import { canonicalize } from '../crawler/src/db.mjs';

const links = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite');
const timeoutMs = Number(process.env.DISCOVERY_TIMEOUT_MS || 20000);
const perSite = Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES_PER_SITE || 500));
const maxSites = Math.max(1, Number(process.env.DISCOVERY_MAX_SITES || 25));
const checkpointSize = Math.max(1, Number(process.env.DISCOVERY_CHECKPOINT_SIZE || 500));
const maxAttempts = Math.max(1, Number(process.env.DISCOVERY_MAX_ATTEMPTS || 3));
const allowedTlds = new Set(['eg', 'com', 'net', 'org', 'edu', 'gov', 'ai', 'jp']);
const blocked = /\.(?:7z|apk|avi|bin|css|csv|docx?|exe|gif|iso|jpe?g|js|m3u8|mp3|mp4|pdf|png|pptx?|rar|svg|tar|webp|woff2?|xlsx?|zip)(?:$|[?#])/i;

function allowed(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || blocked.test(u.pathname) || /^(mailto|tel|javascript):/i.test(url)) return false;
    const labels = u.hostname.toLowerCase().split('.');
    return labels.length >= 2 && allowedTlds.has(labels.at(-1));
  } catch { return false; }
}

function sameHost(a, b) {
  try {
    return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '');
  } catch { return false; }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'BahethMasrDiscovery/2.0 (+resumable-checkpoints)' },
    });
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.toLowerCase().includes('html')) return null;
    return { url: response.url || url, body: await response.text(), type };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function enqueue(siteId, url) {
  const canonical = canonicalize(url);
  if (!canonical || !allowed(canonical)) return false;
  try {
    const result = links.prepare(`
      INSERT OR IGNORE INTO discovery_queue (site_id,url,canonical_url,status)
      VALUES (?,?,?,'pending')
    `).run(siteId, canonical, canonical);
    return result.changes > 0;
  } catch { return false; }
}

function addPage(siteId, url) {
  const canonical = canonicalize(url);
  if (!canonical || !allowed(canonical)) return false;
  try {
    const result = links.prepare(`
      INSERT OR IGNORE INTO site_pages (site_id,url,discovered_at,crawl_status)
      VALUES (?,?,CURRENT_TIMESTAMP,'pending')
    `).run(siteId, canonical);
    return result.changes > 0;
  } catch { return false; }
}

function addSite(url) {
  const canonical = canonicalize(url);
  if (!canonical || !allowed(canonical)) return null;
  const parsed = new URL(canonical);
  const root = `${parsed.protocol}//${parsed.host}/`;
  const found = links.prepare('SELECT id FROM sites WHERE url=? OR url=?').get(root, canonical);
  if (found) {
    enqueue(found.id, canonical);
    return found.id;
  }
  const siteId = links.prepare(`
    INSERT INTO sites (url,name,status,priority,discovery_status,last_discovered_at)
    VALUES (?,?, 'active',50,'pending',CURRENT_TIMESTAMP)
  `).run(root, parsed.hostname).lastInsertRowid;
  enqueue(siteId, root);
  return siteId;
}

function markQueue(id, status, error = '', incrementAttempt = false) {
  links.prepare(`
    UPDATE discovery_queue
    SET status=?, attempts=attempts + ?, last_attempt_at=CURRENT_TIMESTAMP,
        last_error=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, incrementAttempt ? 1 : 0, error.slice(0, 1000), id);
}

function pendingForSite(siteId) {
  return links.prepare(`
    SELECT COUNT(*) AS count FROM discovery_queue
    WHERE site_id=? AND status IN ('pending','processing','failed') AND attempts < ?
  `).get(siteId, maxAttempts).count;
}

for (const seed of String(process.env.DISCOVERY_SEED_URLS || '').split('|').map((value) => value.trim()).filter(Boolean)) {
  const siteId = addSite(seed);
  if (siteId) {
    links.prepare("UPDATE sites SET discovery_status='pending' WHERE id=?").run(siteId);
    enqueue(siteId, seed);
  }
}

function syncCheckpoint() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tools/sync-turso-staging.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`checkpoint_sync_failed_${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

const sites = links.prepare(`
  SELECT id,url FROM sites
  WHERE COALESCE(discovery_status,'pending') IN ('pending','processing')
  ORDER BY COALESCE(last_discovered_at,'') ASC,id
  LIMIT ?
`).all(maxSites);

let sitesScanned = 0;
let pagesQueued = 0;
let externalSites = 0;
let processed = 0;
let checkpoints = 0;
let stoppedByCheckpoint = false;

for (const site of sites) {
  links.prepare("UPDATE sites SET discovery_status='processing' WHERE id=?").run(site.id);
  if (!links.prepare('SELECT 1 FROM discovery_queue WHERE site_id=? LIMIT 1').get(site.id)) enqueue(site.id, site.url);

  let siteProcessed = 0;
  while (siteProcessed < perSite) {
    const item = links.prepare(`
      SELECT id,url FROM discovery_queue
      WHERE site_id=? AND status IN ('pending','processing','failed') AND attempts < ?
      ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, id LIMIT 1
    `).get(site.id, maxAttempts);
    if (!item) break;

    markQueue(item.id, 'processing', '', true);
    const response = await fetchHtml(item.url);
    if (!response) {
      markQueue(item.id, 'failed', 'fetch_failed_or_non_html');
    } else {
      const meta = extractHtml(response.body, response.url, response.type);
      if (sameHost(site.url, response.url)) {
        if (addPage(site.id, response.url)) pagesQueued += 1;
        for (const link of meta.internalLinks) {
          const normalized = canonicalize(link);
          if (normalized && sameHost(site.url, normalized)) enqueue(site.id, normalized);
        }
        for (const link of meta.externalLinks) {
          const normalized = canonicalize(link);
          if (!normalized || !allowed(normalized)) continue;
          const newSite = addSite(normalized);
          if (newSite && newSite !== site.id) {
            externalSites += 1;
            if (addPage(newSite, normalized)) pagesQueued += 1;
          }
        }
      }
      markQueue(item.id, 'completed');
    }

    siteProcessed += 1;
    processed += 1;
    if (processed % checkpointSize === 0) {
      checkpoints += 1;
      console.log(JSON.stringify({ checkpoint: checkpoints, processed, sites_scanned: sitesScanned, pages_queued: pagesQueued }));
      await syncCheckpoint();
      stoppedByCheckpoint = true;
      break;
    }
  }

  const remaining = pendingForSite(site.id);
  links.prepare(`
    UPDATE sites
    SET discovery_status=?, last_discovered_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(remaining > 0 ? 'processing' : 'active', site.id);
  sitesScanned += 1;
  if (stoppedByCheckpoint) break;
}

if (processed > 0 && processed % checkpointSize !== 0) {
  checkpoints += 1;
  console.log(JSON.stringify({ checkpoint: checkpoints, processed, sites_scanned: sitesScanned, pages_queued: pagesQueued }));
  await syncCheckpoint();
}

console.log(JSON.stringify({
  ok: true,
  sites_scanned: sitesScanned,
  pages_processed: processed,
  pages_queued: pagesQueued,
  external_sites_registered: externalSites,
  checkpoints,
  resumable: true,
  stopped_at_checkpoint: stoppedByCheckpoint,
  discovery_only: true,
}, null, 2));
links.close();
