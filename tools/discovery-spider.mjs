import zlib from 'node:zlib';
import Database from 'better-sqlite3';

const DB_PATH = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const MAX_PAGES_PER_SITE = Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES_PER_SITE || 10000));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.DISCOVERY_TIMEOUT_MS || 20000));
const MAX_SITEMAPS = Math.max(1, Number(process.env.DISCOVERY_MAX_SITEMAPS || 2000));
const VALIDATE_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.DISCOVERY_VALIDATE_CONCURRENCY || 10)));
const RESUME_INCOMPLETE = /^(1|true|yes)$/i.test(process.env.DISCOVERY_RESUME_INCOMPLETE || '');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const blockedFile = /\.(?:7z|apk|avi|bin|css|csv|doc|docx|exe|gif|gz|ico|iso|jpe?g|js|json|m3u8|m4a|mp3|mp4|pdf|png|ppt|pptx|rar|rss|svg|tar|txt|webp|woff2?|xls|xlsx|xml|zip)(?:$|[?#])/i;
const blockedPath = /(?:^|\/)(?:admin|administrator|api|cart|checkout|comment|comments|feed|feeds|filter|login|logout|search|tag|tags|label|category|categories|page|pages|wp-admin|wp-json)(?:\/|$)/i;
const blockedPageWords = /(?:about|about-us|contact|contact-us|privacy|privacy-policy|terms|terms-of-service|من[-_ ]?نحن|اتصل[-_ ]?بنا|تواصل[-_ ]?معنا|سياسة[-_ ]?الخصوصية|الشروط[-_ ]?والأحكام)/i;

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
  } catch { return ''; }
}
function sameHost(a, b) {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; }
}
function isPageUrl(raw, siteUrl) {
  const url = canonicalize(raw);
  if (!url || !sameHost(url, siteUrl)) return '';
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname).toLowerCase();
  if (parsed.search || parsed.hash || path === '/robots.txt' || blockedFile.test(path) || blockedPath.test(path) || blockedPageWords.test(path)) return '';
  if (/\/(?:sitemap(?:[-_].*)?|feed|rss|atom)(?:\.xml)?$/i.test(path)) return '';
  if (/\/(?:search|find|query)(?:\/|$)/i.test(path)) return '';
  if (/\/(?:page|p)\/\d+(?:\/|$)/i.test(path)) return '';
  return url;
}
function sitemapUrl(raw, siteUrl) {
  const url = canonicalize(raw);
  if (!url || !sameHost(url, siteUrl)) return '';
  return /(?:sitemap|\.xml)(?:\.gz)?$/i.test(new URL(url).pathname.toLowerCase()) ? url : '';
}
async function fetchResponse(url, method = 'GET') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { method, signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'BahethMasrDiscovery/5.0 (+sitemap-only)' } });
  } catch { return null; } finally { clearTimeout(timer); }
}
async function fetchBytes(url) {
  const response = await fetchResponse(url);
  if (!response?.ok) return null;
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (url.toLowerCase().endsWith('.gz') || (bytes[0] === 0x1f && bytes[1] === 0x8b)) return zlib.gunzipSync(bytes).toString('utf8');
    return bytes.toString('utf8');
  } catch { return null; }
}
async function validPage(url) {
  const head = await fetchResponse(url, 'HEAD');
  if (head && [404, 410].includes(head.status)) return false;
  if (head && head.ok) return true;
  if (head && ![405, 403, 501].includes(head.status)) return false;
  const get = await fetchResponse(url, 'GET');
  return Boolean(get && ![404, 410].includes(get.status) && get.ok);
}
async function mapLimit(items, worker, limit) {
  const out = new Array(items.length); let cursor = 0;
  async function consume() { while (true) { const i = cursor++; if (i >= items.length) return; out[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return out;
}
function xmlLinks(xml, baseUrl, siteUrl) {
  const text = String(xml || '').replace(/^\uFEFF/, '').trim();
  if (!text || /<\s*(?:!doctype\s+html|html\b)/i.test(text)) return { valid: false, pages: [], sitemaps: [] };
  const root = text.match(/<\s*([a-z][\w:.-]*)\b/i)?.[1]?.toLowerCase() || '';
  if (!['urlset', 'sitemapindex', 'feed', 'rss', 'rdf:rdf'].includes(root)) return { valid: false, pages: [], sitemaps: [] };
  const pages = []; const sitemaps = [];
  const add = (raw) => { try { const url = new URL(String(raw).trim(), baseUrl).toString(); const nested = sitemapUrl(url, siteUrl); if (nested && !sitemaps.includes(nested)) sitemaps.push(nested); else { const page = isPageUrl(url, siteUrl); if (page && !pages.includes(page)) pages.push(page); } } catch {} };
  for (const match of text.matchAll(/<loc\b[^>]*>\s*([^<]+?)\s*<\/loc>/gi)) add(match[1]);
  if (root === 'feed' || root === 'rss' || root === 'rdf:rdf') for (const entry of text.matchAll(/<(?:entry|item)\b[\s\S]*?<\/(?:entry|item)>/gi)) { for (const match of entry[0].matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) add(match[1]); for (const match of entry[0].matchAll(/<link\b[^>]*>\s*([^<]+)\s*<\/link>/gi)) add(match[1]); }
  return { valid: true, pages, sitemaps };
}
function sitemapCandidates(siteUrl) {
  const origin = new URL(siteUrl).origin;
  return [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemap/sitemap.xml`, `${origin}/sitemap/sitemap-index.xml`, `${origin}/post-sitemap.xml`, `${origin}/page-sitemap.xml`, `${origin}/sitemap-pages.xml`];
}
function parseCursor(raw, siteUrl) {
  try {
    const x = JSON.parse(raw || '{}');
    return { pendingSitemaps: Array.isArray(x.pendingSitemaps) ? x.pendingSitemaps : sitemapCandidates(siteUrl), seenSitemaps: Array.isArray(x.seenSitemaps) ? x.seenSitemaps : [], currentSitemap: x.currentSitemap || null, currentPageIndex: Number(x.currentPageIndex) || 0 };
  } catch { return { pendingSitemaps: sitemapCandidates(siteUrl), seenSitemaps: [], currentSitemap: null, currentPageIndex: 0 }; }
}
function saveCursor(siteId, cursor) { db.prepare('UPDATE sites SET discovery_cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(cursor), siteId); }

async function discoverSite(site) {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM site_pages WHERE site_id=?').get(site.id).count;
  let totalAccepted = existing; let pagesAdded = 0; let rejected404 = 0; let rejectedInvalid = 0; let sitemapCount = 0;
  const cursor = parseCursor(site.discovery_cursor, site.url);
  const seen = new Set(cursor.seenSitemaps);
  const pending = [...cursor.pendingSitemaps];
  let lastCompletedSitemap = cursor.currentSitemap || null;
  let lastCompletedPageIndex = cursor.currentPageIndex || 0;
  const robots = await fetchBytes(`${new URL(site.url).origin}/robots.txt`);
  for (const line of String(robots || '').split(/\r?\n/)) { const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i); const candidate = match && sitemapUrl(match[1], site.url); if (candidate && !seen.has(candidate) && !pending.includes(candidate)) pending.push(candidate); }
  let current = cursor.currentSitemap;
  let pageIndex = cursor.currentPageIndex;
  while ((current || pending.length) && seen.size < MAX_SITEMAPS) {
    if (!current) { current = pending.shift(); pageIndex = 0; }
    if (seen.has(current) && pageIndex === 0) { current = null; continue; }
    const xml = await fetchBytes(current); const parsed = xmlLinks(xml, current, site.url); sitemapCount += 1;
    if (!parsed.valid) { seen.add(current); current = null; saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: null, currentPageIndex: 0 }); continue; }
    for (const nested of parsed.sitemaps) if (!seen.has(nested) && !pending.includes(nested)) pending.push(nested);
    const pageSlice = parsed.pages.slice(pageIndex);
    const allowed = Math.max(0, MAX_PAGES_PER_SITE - totalAccepted);
    if (allowed === 0) { saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current, currentPageIndex: pageIndex }); break; }
    const candidates = pageSlice.slice(0, allowed);
    const checks = await mapLimit(candidates, validPage, VALIDATE_CONCURRENCY);
    const insert = db.prepare('INSERT OR IGNORE INTO site_pages (site_id,url,crawl_status,crawl_attempts) VALUES (?,? ,\'pending\',0)');
    for (let i = 0; i < candidates.length; i += 1) {
      const page = candidates[i];
      if (!checks[i]) { rejected404 += 1; continue; }
      const result = insert.run(site.id, page); if (result.changes) { pagesAdded += 1; totalAccepted += 1; }
    }
    pageIndex += candidates.length;
    const reachedLimit = totalAccepted >= MAX_PAGES_PER_SITE && pageIndex < parsed.pages.length;
    if (reachedLimit) { saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current, currentPageIndex: pageIndex }); break; }
    seen.add(current); lastCompletedSitemap = current; lastCompletedPageIndex = pageIndex;
    current = null; pageIndex = 0;
    saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: lastCompletedSitemap, currentPageIndex: lastCompletedPageIndex });
  }
  const incomplete = totalAccepted >= MAX_PAGES_PER_SITE && (current || pending.length || seen.size >= MAX_SITEMAPS);
  const status = incomplete ? 'incomplete' : 'completed';
  const finalCursor = { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current || lastCompletedSitemap, currentPageIndex: current ? pageIndex : lastCompletedPageIndex };
  db.prepare('UPDATE sites SET crawl_status=?,discovery_cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, JSON.stringify(finalCursor), site.id);
  return { site_id: site.id, site: site.url, status, sitemaps_scanned: sitemapCount, pages_added: pagesAdded, pages_total: totalAccepted, max_pages: MAX_PAGES_PER_SITE, rejected_404_or_unreachable: rejected404, rejected_invalid: rejectedInvalid, resume_point_saved: incomplete };
}

const requestedSite = canonicalize(process.env.DISCOVERY_SITE_URL || '');
const statuses = RESUME_INCOMPLETE ? "('pending','incomplete')" : "('pending')";
const site = requestedSite ? db.prepare(`SELECT id,url,crawl_status,discovery_cursor FROM sites WHERE crawl_status IN ${statuses} AND (url=? OR url=?) LIMIT 1`).get(requestedSite, `${requestedSite}/`) : db.prepare(`SELECT id,url,crawl_status,discovery_cursor FROM sites WHERE crawl_status IN ${statuses} ORDER BY CASE WHEN crawl_status='pending' THEN 0 ELSE 1 END,id LIMIT 1`).get();
if (!site) { console.log(JSON.stringify({ ok: true, message: RESUME_INCOMPLETE ? 'no_pending_or_incomplete_site' : 'no_pending_site', processed_sites: 0 }, null, 2)); db.close(); process.exit(0); }
db.prepare("UPDATE sites SET crawl_status='processing',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id);
try { console.log(JSON.stringify({ ok: true, processed_sites: 1, ...(await discoverSite(site)), resume_incomplete_enabled: RESUME_INCOMPLETE }, null, 2)); } catch (error) { db.prepare("UPDATE sites SET crawl_status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id); console.error(JSON.stringify({ ok: false, site_id: site.id, site: site.url, error: String(error) }, null, 2)); process.exitCode = 1; } finally { db.close(); }

export { canonicalize, isPageUrl, xmlLinks };
