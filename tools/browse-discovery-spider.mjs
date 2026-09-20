import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import * as cheerio from 'cheerio';

const DB_PATH = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const MAX_PAGES = Math.max(1, Number(process.env.BROWSE_MAX_PAGES || 10000));
const PAGE_TIMEOUT_MS = Math.max(5000, Number(process.env.BROWSE_PAGE_TIMEOUT_MS || 30000));
const BROWSER_BUDGET_MS = Math.max(1000, Number(process.env.BROWSE_BROWSER_BUDGET_MS || 10000));
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const blockedFile = /\.(?:7z|apk|avi|bin|css|csv|docx?|exe|gif|gz|ico|jpe?g|js|json|m3u8|m4a|mp3|mp4|pdf|png|pptx?|rar|rss|svg|tar|txt|webp|woff2?|xlsx?|xml|zip)(?:$|[?#])/i;
const blockedPath = /(?:^|\/)(?:admin|administrator|api|cart|checkout|comment|comments|feed|feeds|filter|login|logout|search|tag|tags|label|category|categories|wp-admin|wp-json)(?:\/|$)/i;
const blockedWords = /(?:about|about-us|contact|contact-us|privacy|privacy-policy|terms|terms-of-service|من[-_ ]?نحن|اتصل[-_ ]?بنا|تواصل[-_ ]?معنا|سياسة[-_ ]?الخصوصية|الشروط[-_ ]?والأحكام)/i;
const arabicText = /[\u0600-\u06FF]/;

function canonicalize(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    u.hash = '';
    u.username = '';
    u.password = '';
    // Preserve the requested host for fetching: some sites serve different
    // content or reject requests when the www prefix is removed. Host
    // equivalence is still handled by sameHost() for internal-link checks.
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    u.pathname = u.pathname.replace(/\/index\.(?:html?|php)$/i, '/') || '/';
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    [...u.searchParams.keys()].forEach((key) => u.searchParams.delete(key));
    return u.toString();
  } catch { return ''; }
}
function sameHost(a, b) {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; }
}
function pageUrl(raw, siteUrl) {
  try {
    const url = canonicalize(new URL(raw, siteUrl).toString());
    if (!url || !sameHost(url, siteUrl)) return '';
    const path = decodeURIComponent(new URL(url).pathname).toLowerCase();
    if (blockedFile.test(path) || blockedPath.test(path) || blockedWords.test(path)) return '';
    if (/\/(?:sitemap(?:[-_].*)?|rss|atom)(?:\.xml)?$/i.test(path)) return '';
    return url;
  } catch { return ''; }
}
function hasArabic(value) { return arabicText.test(String(value || '')); }
function extractLinks(html, siteUrl) {
  const $ = cheerio.load(html);
  const links = new Map();
  $('a[href]').each((_, element) => {
    const url = pageUrl($(element).attr('href'), siteUrl);
    if (!url || links.has(url)) return;
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    let path = '';
    try { path = decodeURIComponent(new URL(url).pathname); } catch {}
    links.set(url, { url, text, hasArabic: hasArabic(`${text} ${path}`) });
  });
  return [...links.values()];
}
async function render(url) {
  let rawHtml = '';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: { 'user-agent': 'BahethMasrBrowseSpider/1.0' } });
    if (!response.ok) return '';
    rawHtml = response.ok ? await response.text() : '';
    // Static pages are faster and more reliable through HTTP, and this also
    // avoids starting Chromium for ordinary server-rendered government pages.
    if ((rawHtml.match(/<a\b[^>]*href=/gi) || []).length > 0) return rawHtml;
  } catch {}

  return new Promise((resolve) => {
    const child = spawn('/usr/bin/chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--virtual-time-budget=${BROWSER_BUDGET_MS}`, '--run-all-compositor-stages-before-draw', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let html = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, PAGE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { html += chunk; });
    child.on('close', async (code) => {
      clearTimeout(timer);
      // Chromium can finish with a non-zero code after emitting usable DOM,
      // but it can also emit an incomplete error document with no links. Use
      // rendered DOM when it contains links; otherwise try the raw response.
      if ((html.match(/<a\b[^>]*href=/gi) || []).length > 0) return resolve(html);
      resolve(rawHtml || html);
    });
  });
}
async function browseSite(site) {
  const homepage = pageUrl(site.url, site.url);
  if (!homepage) throw new Error(`Invalid site URL: ${site.url}`);
  const existing = db.prepare('SELECT COUNT(*) AS count FROM site_pages WHERE site_id=?').get(site.id).count;
  let accepted = existing;
  let pagesAdded = 0;
  let pagesVisited = 0;
  const visitedUrls = new Set();
  const discoveredUrls = new Set();
  const insert = db.prepare("INSERT OR IGNORE INTO site_pages (site_id,url,crawl_status,crawl_attempts) VALUES (?,?,'pending',0)");
  const addPage = (url) => {
    if (!url || accepted >= MAX_PAGES || discoveredUrls.has(url)) return false;
    discoveredUrls.add(url);
    const result = insert.run(site.id, url);
    if (result.changes) { accepted += 1; pagesAdded += 1; }
    return true;
  };
  const html = await render(homepage);
  if (!html) throw new Error('homepage_unavailable');
  if (html) {
    pagesVisited += 1;
    visitedUrls.add(homepage);
    addPage(homepage);
    const homepageLinks = extractLinks(html, site.url);
    for (const link of homepageLinks) addPage(link.url);

    // Expand only Arabic links found directly on the homepage. Links found
    // inside those pages are queued, but are never opened by this spider.
    const arabicHomepageLinks = homepageLinks.filter((link) => link.hasArabic);
    for (const link of arabicHomepageLinks) {
      if (accepted >= MAX_PAGES || visitedUrls.has(link.url)) continue;
      const childHtml = await render(link.url);
      visitedUrls.add(link.url);
      if (!childHtml) continue;
      pagesVisited += 1;
      for (const childLink of extractLinks(childHtml, site.url)) addPage(childLink.url);
    }
  }

  const status = accepted > existing ? 'completed' : 'not_pages';
  const cursor = JSON.stringify({ mode: 'homepage_links_plus_arabic_one_level', sourceUrl: homepage, visited: pagesVisited, arabicLinksExpanded: Math.max(0, visitedUrls.size - (html ? 1 : 0)), linksAdded: Math.max(0, pagesAdded - 1) });
  db.prepare('UPDATE sites SET crawl_status=?,discovery_cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, cursor, site.id);
  return { site_id: site.id, site: site.url, status, pages_added: pagesAdded, pages_total: accepted, pages_visited: pagesVisited, max_pages: MAX_PAGES, discovery_method: 'homepage_html_links_plus_arabic_one_level' };
}

const site = db.prepare("SELECT id,url,crawl_status FROM sites WHERE crawl_status='not_pages' ORDER BY id LIMIT 1").get();
if (!site) {
  console.log(JSON.stringify({ ok: true, message: 'no_not_pages_site', processed_sites: 0 }, null, 2));
  db.close();
  process.exit(0);
}
db.prepare("UPDATE sites SET crawl_status='processing',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id);
try {
  console.log(JSON.stringify({ ok: true, processed_sites: 1, ...(await browseSite(site)) }, null, 2));
} catch (error) {
  const errorCursor = JSON.stringify({ mode: 'homepage_links_plus_arabic_one_level', sourceUrl: site.url, error: String(error?.message || error), terminal: true, updatedAt: new Date().toISOString() });
  // error is terminal by design: the selector below only ever picks
  // not_pages, so a failed site will never be retried automatically.
  db.prepare("UPDATE sites SET crawl_status='error',discovery_cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(errorCursor, site.id);
  console.error(JSON.stringify({ ok: false, site_id: site.id, site: site.url, error: String(error) }, null, 2));
  // Keep the process successful so the workflow can verify and persist the
  // terminal error state instead of stopping before the database is saved.
} finally { db.close(); }
