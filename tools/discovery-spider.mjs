import zlib from 'node:zlib';
import Database from 'better-sqlite3';

const DB_PATH = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const MAX_PAGES_PER_SITE = Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES_PER_SITE || 10000));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.DISCOVERY_TIMEOUT_MS || 20000));
const MAX_SITEMAPS = Math.max(1, Number(process.env.DISCOVERY_MAX_SITEMAPS || 2000));
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const blockedFile = /\.(?:7z|apk|avi|bin|css|csv|doc|docx|exe|gif|gz|ico|iso|jpe?g|js|json|m3u8|m4a|mp3|mp4|pdf|png|ppt|pptx|rar|rss|svg|tar|txt|webp|woff2?|xls|xlsx|xml|zip)(?:$|[?#])/i;
const blockedPath = /(?:^|\/)(?:admin|administrator|api|cart|checkout|comment|comments|feed|feeds|filter|login|logout|search|tag|tags|label|category|page|wp-admin|wp-json)(?:\/|$)/i;

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
    for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return '';
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

function isPageUrl(raw, siteUrl) {
  const url = canonicalize(raw);
  if (!url || !sameHost(url, siteUrl)) return '';
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();
  if (parsed.search || parsed.hash || path === '/robots.txt' || blockedFile.test(path) || blockedPath.test(path)) return '';
  if (/\/(?:sitemap(?:[-_].*)?|feed|rss|atom)(?:\.xml)?$/i.test(path)) return '';
  if (/\/(?:search|find|query)(?:\/|$)/i.test(path)) return '';
  if (/\/(?:page|p)\/\d+(?:\/|$)/i.test(path)) return '';
  return url;
}

function sitemapUrl(raw, siteUrl) {
  const url = canonicalize(raw);
  if (!url || !sameHost(url, siteUrl)) return '';
  const path = new URL(url).pathname.toLowerCase();
  return /(?:sitemap|\.xml)(?:\.gz)?$/i.test(path) ? url : '';
}

async function fetchBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'BahethMasrDiscovery/4.0 (+sitemap-only)' },
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (url.toLowerCase().endsWith('.gz') || (bytes[0] === 0x1f && bytes[1] === 0x8b)) return zlib.gunzipSync(bytes).toString('utf8');
    return bytes.toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function xmlLinks(xml, baseUrl, siteUrl) {
  const text = String(xml || '').replace(/^\uFEFF/, '').trim();
  if (!text || /<\s*(?:!doctype\s+html|html\b)/i.test(text)) return { valid: false, pages: [], sitemaps: [] };
  const root = text.match(/<\s*([a-z][\w:.-]*)\b/i)?.[1]?.toLowerCase() || '';
  if (!['urlset', 'sitemapindex', 'feed', 'rss', 'rdf:rdf'].includes(root)) return { valid: false, pages: [], sitemaps: [] };
  const pages = [];
  const sitemaps = [];
  const add = (raw) => {
    try {
      const url = new URL(String(raw).trim(), baseUrl).toString();
      const nested = sitemapUrl(url, siteUrl);
      if (nested && !sitemaps.includes(nested)) sitemaps.push(nested);
      else {
        const page = isPageUrl(url, siteUrl);
        if (page && !pages.includes(page)) pages.push(page);
      }
    } catch {}
  };
  for (const match of text.matchAll(/<loc\b[^>]*>\s*([^<]+?)\s*<\/loc>/gi)) add(match[1]);
  if (root === 'feed' || root === 'rss' || root === 'rdf:rdf') {
    for (const entry of text.matchAll(/<(?:entry|item)\b[\s\S]*?<\/(?:entry|item)>/gi)) {
      for (const match of entry[0].matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
      for (const match of entry[0].matchAll(/<link\b[^>]*>\s*([^<]+)\s*<\/link>/gi)) add(match[1]);
    }
  }
  return { valid: true, pages, sitemaps };
}

function sitemapCandidates(siteUrl) {
  const root = new URL(siteUrl);
  const origin = root.origin;
  return new Set([
    `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`,
    `${origin}/sitemap/sitemap.xml`, `${origin}/sitemap/sitemap-index.xml`,
    `${origin}/post-sitemap.xml`, `${origin}/page-sitemap.xml`, `${origin}/sitemap-pages.xml`,
  ]);
}

async function discoverSite(site) {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM pages_queue WHERE site_id=?').get(site.id).count;
  const queued = new Set();
  const insertPage = db.prepare('INSERT OR IGNORE INTO pages_queue (site_id,url,indexed) VALUES (?,? ,0)');
  let pagesAdded = 0;
  let hasMore = false;
  let sitemapCount = 0;
  const seenSitemaps = new Set();
  const pendingSitemaps = [...sitemapCandidates(site.url)];
  const robots = await fetchBytes(`${new URL(site.url).origin}/robots.txt`);
  for (const line of String(robots || '').split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (match) {
      const candidate = sitemapUrl(match[1], site.url);
      if (candidate) pendingSitemaps.push(candidate);
    }
  }

  while (pendingSitemaps.length && seenSitemaps.size < MAX_SITEMAPS) {
    const sitemap = pendingSitemaps.shift();
    if (seenSitemaps.has(sitemap)) continue;
    seenSitemaps.add(sitemap);
    sitemapCount += 1;
    const xml = await fetchBytes(sitemap);
    const parsed = xmlLinks(xml, sitemap, site.url);
    if (!parsed.valid) continue;
    for (const nested of parsed.sitemaps) if (!seenSitemaps.has(nested) && !pendingSitemaps.includes(nested)) pendingSitemaps.push(nested);
    for (const page of parsed.pages) {
      if (queued.has(page)) continue;
      queued.add(page);
      const totalBefore = existing + pagesAdded;
      if (totalBefore >= MAX_PAGES_PER_SITE) {
        hasMore = true;
        break;
      }
      const result = insertPage.run(site.id, page);
      if (result.changes) pagesAdded += 1;
    }
    if (hasMore) break;
  }
  if (!hasMore && (pendingSitemaps.length || seenSitemaps.size >= MAX_SITEMAPS)) hasMore = true;
  const totalPages = existing + pagesAdded;
  const status = hasMore ? 'incomplete' : 'completed';
  db.prepare('UPDATE sites SET crawl_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, site.id);
  return { site_id: site.id, site: site.url, status, sitemaps_scanned: sitemapCount, pages_added: pagesAdded, pages_total: totalPages, max_pages: MAX_PAGES_PER_SITE, more_pages_available: hasMore };
}

const site = db.prepare("SELECT id,url,crawl_status FROM sites WHERE crawl_status='pending' ORDER BY id LIMIT 1").get();
if (!site) {
  console.log(JSON.stringify({ ok: true, message: 'no_pending_site', processed_sites: 0 }, null, 2));
  db.close();
  process.exit(0);
}

db.prepare("UPDATE sites SET crawl_status='processing',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id);
try {
  const result = await discoverSite(site);
  console.log(JSON.stringify({ ok: true, processed_sites: 1, ...result }, null, 2));
} catch (error) {
  db.prepare("UPDATE sites SET crawl_status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id);
  console.error(JSON.stringify({ ok: false, site_id: site.id, site: site.url, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
}

export { canonicalize, isPageUrl, xmlLinks };
