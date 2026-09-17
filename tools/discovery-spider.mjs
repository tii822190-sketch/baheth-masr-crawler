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
const browserBudgetMs = Math.max(1000, Number(process.env.DISCOVERY_BROWSER_BUDGET_MS || 12000));
const registerExternalSites = process.env.DISCOVERY_REGISTER_EXTERNAL_SITES === '1';
const sitemapLimit = Math.max(1, Number(process.env.DISCOVERY_MAX_SITEMAP_URLS || 5000));
const archiveLimit = Math.max(1, Number(process.env.DISCOVERY_MAX_ARCHIVE_URLS || 5000));
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

async function browserHtml(url) {
  return await new Promise((resolve) => {
    const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--virtual-time-budget=${browserBudgetMs}`, '--run-all-compositor-stages-before-draw', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let body = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, timeoutMs + browserBudgetMs);
    child.stdout.on('data', (chunk) => { body += chunk; });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && body.trim() ? { url, body, type: 'text/html' } : null); });
  });
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
    const body = await response.text();
    const meta = extractHtml(body, response.url || url, type);
    if (meta.qualityStatus === 'dynamic_content' || meta.extractedText.length < 80) return (await browserHtml(response.url || url)) || { url: response.url || url, body, type };
    return { url: response.url || url, body, type };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'BahethMasrDiscovery/3.0 (+sitemap-first)' } });
    if (!response.ok) return '';
    return await response.text();
  } catch { return ''; }
  finally { clearTimeout(timer); }
}

async function discoverFromArchive(siteId, siteUrl, persist = async () => {}) {
  const host = new URL(siteUrl).hostname;
  const endpoint = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(`${host}/*`)}&output=txt&filter=statuscode:200&collapse=urlkey&fl=original&limit=${archiveLimit}`;
  const body = await fetchText(endpoint);
  let added = 0;
  for (const raw of body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    let url;
    try { url = new URL(raw.replace(/^\[?"|"\]?$/g, ''), siteUrl).toString(); } catch { continue; }
    if (allowed(url) && sameHost(siteUrl, url) && addPage(siteId, url)) {
      added += 1;
      if (added % checkpointSize === 0) await persist();
    }
  }
  return added;
}

async function discoverSitemaps(siteId, siteUrl, persist = async () => {}) {
  const root = new URL(siteUrl);
  const candidates = new Set([`${root.origin}/robots.txt`, `${root.origin}/sitemap.xml`, `${root.origin}/sitemap_index.xml`, `${root.origin}/sitemap-index.xml`, `${root.origin}/sitemap/sitemap.xml`, `${root.origin}/sitemap/sitemap-index.xml`, `${root.origin}/post-sitemap.xml`, `${root.origin}/page-sitemap.xml`, `${root.origin}/sitemap-pages.xml`]);
  const robots = await fetchText(`${root.origin}/robots.txt`);
  for (const line of robots.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (match && allowed(match[1])) candidates.add(match[1]);
  }
  const pending = [...candidates];
  const seen = new Set();
  let added = 0;
  while (pending.length && seen.size < sitemapLimit && added < sitemapLimit) {
    const sitemapUrl = pending.shift();
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    const xml = await fetchText(sitemapUrl);
    if (!xml || !/<(?:urlset|sitemapindex)\b/i.test(xml)) continue;
    const isIndex = /<sitemapindex\b/i.test(xml);
    for (const match of xml.matchAll(/<loc[^>]*>\s*([^<]+?)\s*<\/loc>/gi)) {
      let url;
      try { url = new URL(match[1].trim(), sitemapUrl).toString(); } catch { continue; }
      if (!allowed(url) || !sameHost(siteUrl, url)) continue;
      if (isIndex || /(?:sitemap(?:[-_].*)?|\.xml)(?:\.gz)?$/i.test(url)) pending.push(url);
      else if (addPage(siteId, url)) {
        added += 1;
        if (added % checkpointSize === 0) await persist();
      }
      if (added >= sitemapLimit) break;
    }
  }
  return { added, sitemaps: seen.size };
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
  const persistBatch = async () => {
    checkpoints += 1;
    console.log(JSON.stringify({ checkpoint: checkpoints, processed, sites_scanned: sitesScanned, pages_queued: pagesQueued }));
    await syncCheckpoint();
  };
  const sitemapResult = await discoverSitemaps(site.id, site.url, persistBatch).catch(() => ({ added: 0, sitemaps: 0 }));
  pagesQueued += sitemapResult.added;
  if (sitemapResult.sitemaps) console.log(JSON.stringify({ sitemap_first: true, site: site.url, sitemaps: sitemapResult.sitemaps, pages_from_sitemaps: sitemapResult.added }));
  if (!sitemapResult.added) {
    const archiveAdded = await discoverFromArchive(site.id, site.url, persistBatch).catch(() => 0);
    pagesQueued += archiveAdded;
    if (archiveAdded) console.log(JSON.stringify({ archive_fallback: true, site: site.url, pages_from_archive: archiveAdded }));
  }
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
        if (addPage(site.id, response.url)) {
          pagesQueued += 1;
          if (pagesQueued % checkpointSize === 0) await persistBatch();
        }
        for (const link of meta.internalLinks) {
          const normalized = canonicalize(link);
          if (normalized && sameHost(site.url, normalized)) enqueue(site.id, normalized);
        }
        for (const link of registerExternalSites ? meta.externalLinks : []) {
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
