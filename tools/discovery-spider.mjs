import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import * as cheerio from 'cheerio';

const DB_PATH = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const MAX_PAGES_PER_SITE = Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES_PER_SITE || 5000));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.DISCOVERY_TIMEOUT_MS || 20000));
const MAX_SITEMAPS = Math.max(1, Number(process.env.DISCOVERY_MAX_SITEMAPS || 2000));
const RESUME_INCOMPLETE = /^(1|true|yes)$/i.test(process.env.DISCOVERY_RESUME_INCOMPLETE || '');
const BROWSER_BUDGET_MS = Math.max(1000, Number(process.env.DISCOVERY_BROWSER_BUDGET_MS || 30000));
const BROWSER_SCROLL_STEPS = Math.max(1, Number(process.env.DISCOVERY_BROWSER_SCROLL_STEPS || 6));
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
async function mapLimit(items, worker, limit) {
  const out = new Array(items.length); let cursor = 0;
  async function consume() { while (true) { const i = cursor++; if (i >= items.length) return; out[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return out;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function renderInteractive(url) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=0','--remote-allow-origins=*','--no-first-run','--no-default-browser-check'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; let settled = false; let connecting = false;
    const finish = (html = '') => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(html); };
    const timer = setTimeout(() => finish(''), REQUEST_TIMEOUT_MS + BROWSER_BUDGET_MS + 10000);
    child.stderr.on('data', async (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/);
      if (!match || settled || connecting) return;
      connecting = true;
      try {
        const targets = await fetch(`http://127.0.0.1:${match[2]}/json/list`).then((response) => response.json());
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (!target) return finish('');
        const socket = new WebSocket(target.webSocketDebuggerUrl); let nextId = 0; const pending = new Map();
        socket.onmessage = (event) => { const message = JSON.parse(event.data); const callback = pending.get(message.id); if (callback) { pending.delete(message.id); callback(message); } };
        const command = (method, params = {}) => new Promise((resolveCommand, reject) => { const id = ++nextId; pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolveCommand(message)); socket.send(JSON.stringify({ id, method, params })); });
        socket.onopen = async () => {
          try {
            await command('Page.enable'); await command('Runtime.enable'); await command('Page.navigate', { url }); await sleep(BROWSER_BUDGET_MS);
            const expression = `(async()=>{for(let i=0;i<${BROWSER_SCROLL_STEPS};i++){window.scrollTo(0,document.body.scrollHeight);await new Promise(r=>setTimeout(r,1000));}window.scrollTo(0,0);return document.documentElement.outerHTML;})()`;
            const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); socket.close(); finish(result.result?.result?.value || '');
          } catch { try { socket.close(); } catch {} finish(''); }
        };
        socket.onerror = () => finish('');
      } catch { finish(''); }
    });
    child.on('error', () => finish(''));
  });
}
async function renderDumpDom(url) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--virtual-time-budget=${BROWSER_BUDGET_MS}`,'--run-all-compositor-stages-before-draw','--dump-dom',url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let html = ''; const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(''); }, REQUEST_TIMEOUT_MS + BROWSER_BUDGET_MS + 10000);
    child.stdout.on('data', (chunk) => { html += chunk; });
    child.on('close', () => { clearTimeout(timer); resolve(html); });
  });
}
async function renderPage(url) {
  let rawHtml = '';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'user-agent': 'BahethMasrDiscovery/5.0' } });
    if (response.ok) rawHtml = await response.text();
    if ((rawHtml.match(/<a\b[^>]*href=/gi) || []).length > 0) return rawHtml;
  } catch {}
  return (await renderInteractive(url)) || (await renderDumpDom(url)) || rawHtml;
}
function extractHtmlLinks(html, siteUrl) {
  const $ = cheerio.load(html); const links = new Map();
  $('a[href]').each((_, element) => {
    const url = isPageUrl($(element).attr('href'), siteUrl); if (!url || links.has(url)) return;
    const text = $(element).text().replace(/\s+/g, ' ').trim(); let pagePath = '';
    try { pagePath = decodeURIComponent(new URL(url).pathname); } catch {}
    links.set(url, { url, hasArabic: /[\u0600-\u06FF]/.test(`${text} ${pagePath}`) });
  });
  return [...links.values()];
}
function isLanguageOnlyUrl(url) {
  try { return /^\/(?:ar|en|fr|de|es|it|ru|zh)(?:\/)?$/i.test(new URL(url).pathname); } catch { return false; }
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
  let totalAccepted = existing; let pagesAdded = 0; let sitemapCount = 0;
  const insert = db.prepare("INSERT OR IGNORE INTO site_pages (site_id,url,crawl_status,crawl_attempts) VALUES (?,? ,'pending',0)");
  const homepage = isPageUrl(site.url, site.url);
  if (homepage && totalAccepted < MAX_PAGES_PER_SITE) {
    const result = insert.run(site.id, homepage);
    if (result.changes) { pagesAdded += 1; totalAccepted += 1; }
  }
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
    for (let i = 0; i < candidates.length; i += 1) {
      const page = candidates[i];
      const result = insert.run(site.id, page); if (result.changes) { pagesAdded += 1; totalAccepted += 1; }
    }
    pageIndex += candidates.length;
    const reachedLimit = totalAccepted >= MAX_PAGES_PER_SITE && pageIndex < parsed.pages.length;
    if (reachedLimit) { saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current, currentPageIndex: pageIndex }); break; }
    seen.add(current); lastCompletedSitemap = current; lastCompletedPageIndex = pageIndex;
    current = null; pageIndex = 0;
    saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: lastCompletedSitemap, currentPageIndex: lastCompletedPageIndex });
  }
  let browserFallback = { attempted: false, pagesVisited: 0, linksAdded: 0, contentLinksAdded: 0, languageLinksAdded: 0, arabicLinksExpanded: 0 };
  if (pagesAdded <= 1 && homepage && totalAccepted < MAX_PAGES_PER_SITE) {
    browserFallback.attempted = true;
    const queued = new Set();
    const addBrowserPage = (url) => {
      if (!url || totalAccepted >= MAX_PAGES_PER_SITE || queued.has(url)) return false;
      queued.add(url);
      const result = insert.run(site.id, url);
      if (result.changes) {
        totalAccepted += 1; pagesAdded += 1; browserFallback.linksAdded += 1;
        if (isLanguageOnlyUrl(url)) browserFallback.languageLinksAdded += 1;
        else browserFallback.contentLinksAdded += 1;
      }
      return true;
    };
    const homepageHtml = await renderPage(homepage);
    if (homepageHtml) {
      browserFallback.pagesVisited += 1;
      addBrowserPage(homepage);
      const homepageLinks = extractHtmlLinks(homepageHtml, site.url);
      for (const link of homepageLinks) addBrowserPage(link.url);
      for (const link of homepageLinks.filter((item) => item.hasArabic)) {
        if (totalAccepted >= MAX_PAGES_PER_SITE) break;
        const childHtml = await renderPage(link.url);
        browserFallback.arabicLinksExpanded += 1;
        if (!childHtml) continue;
        browserFallback.pagesVisited += 1;
        for (const childLink of extractHtmlLinks(childHtml, site.url)) addBrowserPage(childLink.url);
      }
    }
  }
  const incomplete = totalAccepted >= MAX_PAGES_PER_SITE && (current || pending.length || seen.size >= MAX_SITEMAPS);
  const fallbackFailed = browserFallback.attempted && browserFallback.contentLinksAdded === 0;
  const status = fallbackFailed ? 'not_pages' : incomplete ? 'incomplete' : 'completed';
  const finalCursor = { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current || lastCompletedSitemap, currentPageIndex: current ? pageIndex : lastCompletedPageIndex, browserFallback };
  db.prepare('UPDATE sites SET crawl_status=?,discovery_cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, JSON.stringify(finalCursor), site.id);
  return { site_id: site.id, site: site.url, status, sitemaps_scanned: sitemapCount, pages_added: pagesAdded, pages_total: totalAccepted, max_pages: MAX_PAGES_PER_SITE, resume_point_saved: incomplete, browser_fallback: browserFallback, validation: 'deferred_to_crawler' };
}

const requestedSite = canonicalize(process.env.DISCOVERY_SITE_URL || '');
const statuses = RESUME_INCOMPLETE ? "('pending','incomplete')" : "('pending')";
const site = requestedSite ? db.prepare(`SELECT id,url,crawl_status,discovery_cursor FROM sites WHERE crawl_status IN ${statuses} AND (url=? OR url=?) LIMIT 1`).get(requestedSite, `${requestedSite}/`) : db.prepare(`SELECT id,url,crawl_status,discovery_cursor FROM sites WHERE crawl_status IN ${statuses} ORDER BY CASE WHEN crawl_status='pending' THEN 0 ELSE 1 END,id LIMIT 1`).get();
if (!site) { console.log(JSON.stringify({ ok: true, message: RESUME_INCOMPLETE ? 'no_pending_or_incomplete_site' : 'no_pending_site', processed_sites: 0 }, null, 2)); db.close(); process.exit(0); }
db.prepare("UPDATE sites SET crawl_status='processing',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id);
try { console.log(JSON.stringify({ ok: true, processed_sites: 1, ...(await discoverSite(site)), resume_incomplete_enabled: RESUME_INCOMPLETE }, null, 2)); } catch (error) { db.prepare("UPDATE sites SET crawl_status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id); console.error(JSON.stringify({ ok: false, site_id: site.id, site: site.url, error: String(error) }, null, 2)); process.exitCode = 1; } finally { db.close(); }

export { canonicalize, isPageUrl, xmlLinks };
