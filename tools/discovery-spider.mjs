import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import * as cheerio from 'cheerio';
import { feedCandidates, sitemapCandidates } from './sitemap-candidates.mjs';
import { fetchRobotsPolicy, isRobotsAllowed } from './robots.mjs';
import { canonicalize, declaredSitemapLinks, htmlArabicAlternateLinks, htmlSitemapLinks, isPageUrl, normalizeSitemapUrl, pageUrlDecision, shouldHydratePage, xmlLinks } from './sitemap-parser.mjs';

const DB_PATH = process.env.CRAWLER_DB_PATH || 'db/crawler.sqlite';
const MAX_PAGES_PER_SITE = Math.min(10000, Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES_PER_SITE || 10000)));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.DISCOVERY_TIMEOUT_MS || 20000));
const MAX_SITEMAPS = Math.max(1, Number(process.env.DISCOVERY_MAX_SITEMAPS || 2000));
const RESUME_INCOMPLETE = /^(1|true|yes)$/i.test(process.env.DISCOVERY_RESUME_INCOMPLETE || '');
const BROWSER_BUDGET_MS = Math.max(1000, Number(process.env.DISCOVERY_BROWSER_BUDGET_MS || 30000));
const BROWSER_SCROLL_STEPS = Math.max(1, Number(process.env.DISCOVERY_BROWSER_SCROLL_STEPS || 6));
const BROWSER_FALLBACK_TOTAL_MS = Math.max(10000, Number(process.env.DISCOVERY_BROWSER_TOTAL_MS || 90000));
const BROWSER_FALLBACK_MAX_PAGES = Math.max(1, Number(process.env.DISCOVERY_BROWSER_MAX_PAGES || 10));
const BROWSER_FALLBACK_MAX_DEPTH = Math.max(1, Number(process.env.DISCOVERY_BROWSER_MAX_DEPTH || 2));
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

async function fetchDocument(url, { method = 'GET', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'BahethMasrDiscovery/5.1 (+sitemap-feed-browser)' } });
    if (!response.ok) return { ok: false, status: response.status, finalUrl: response.url || url, contentType: response.headers.get('content-type') || '', bytes: 0, body: '', reason: `http_${response.status}` };
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
      return { ok: true, status: response.status, finalUrl: response.url || url, contentType: response.headers.get('content-type') || '', bytes: bytes.length, body, reason: null };
    } catch (error) {
      return { ok: false, status: response.status, finalUrl: response.url || url, contentType: response.headers.get('content-type') || '', bytes: 0, body: '', reason: /gzip|header|buffer/i.test(String(error)) ? 'invalid_compression' : 'body_read_error' };
    }
  } catch (error) {
    const reason = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
    return { ok: false, status: 0, finalUrl: url, contentType: '', bytes: 0, body: '', reason };
  } finally { clearTimeout(timer); }
}
function safeUrl(raw) {
  try { const url = new URL(raw); return `${url.origin}${url.pathname}${url.search ? '?[query]' : ''}`; } catch { return String(raw || ''); }
}
async function mapLimit(items, worker, limit) {
  const out = new Array(items.length); let cursor = 0;
  async function consume() { while (true) { const i = cursor++; if (i >= items.length) return; out[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return out;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function renderInteractive(url, budgetMs = BROWSER_BUDGET_MS, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-agent=BahethMasrDiscovery/1.0','--remote-debugging-port=0','--remote-allow-origins=*','--no-first-run','--no-default-browser-check'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; let settled = false; let connecting = false;
    const finish = (html = '') => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(html); };
    const timer = setTimeout(() => finish(''), timeoutMs + budgetMs + 3000);
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
            await command('Page.enable'); await command('Runtime.enable'); await command('Page.navigate', { url }); await sleep(budgetMs);
            const scrollSteps = Math.min(BROWSER_SCROLL_STEPS, Math.max(1, Math.floor(budgetMs / 1500)));
            const expression = `(async()=>{for(let i=0;i<${scrollSteps};i++){window.scrollTo(0,document.body.scrollHeight);await new Promise(r=>setTimeout(r,1000));}window.scrollTo(0,0);return document.documentElement.outerHTML;})()`;
            const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); socket.close(); finish(result.result?.result?.value || '');
          } catch { try { socket.close(); } catch {} finish(''); }
        };
        socket.onerror = () => finish('');
      } catch { finish(''); }
    });
    child.on('error', () => finish(''));
  });
}
async function renderDumpDom(url, budgetMs = BROWSER_BUDGET_MS, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-agent=BahethMasrDiscovery/1.0',`--virtual-time-budget=${budgetMs}`,'--run-all-compositor-stages-before-draw','--dump-dom',url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let html = ''; const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(''); }, timeoutMs + budgetMs + 3000);
    child.stdout.on('data', (chunk) => { html += chunk; });
    child.on('close', () => { clearTimeout(timer); resolve(html); });
  });
}
async function renderPage(url, initialDocument = null, browserBudgetMs = BROWSER_BUDGET_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, deadline = 0) {
  const remainingMs = () => deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY;
  let rawHtml = initialDocument?.ok ? initialDocument.body : '';
  let rawFailure = initialDocument && !initialDocument.ok ? initialDocument.reason : null;
  if (!initialDocument) {
    try {
      const httpTimeout = Math.max(1000, Math.min(requestTimeoutMs, Math.floor(remainingMs() / 3)));
      const response = await fetch(url, { signal: AbortSignal.timeout(httpTimeout), headers: { 'user-agent': 'BahethMasrDiscovery/1.0' } });
      if (response.ok) rawHtml = await response.text();
      else rawFailure = `http_${response.status}`;
    } catch (error) { rawFailure = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error'; }
  }
  if (rawHtml && !shouldHydratePage(rawHtml)) return { html: rawHtml, method: 'http', httpFailure: null };
  if (deadline && remainingMs() < 2000) return { html: rawHtml, method: rawHtml ? 'http_only' : 'unavailable', httpFailure: rawFailure, browserFailure: 'time_budget_exhausted' };
  const interactiveBudget = Math.max(1000, Math.min(browserBudgetMs, Math.floor(remainingMs() / 3)));
  const interactiveTimeout = Math.max(1000, Math.min(requestTimeoutMs, Math.floor(remainingMs() / 3)));
  const interactive = await renderInteractive(url, interactiveBudget, interactiveTimeout);
  if (interactive) return { html: `${rawHtml}\n${interactive}`, method: 'browser_interactive', httpFailure: rawFailure };
  if (deadline && remainingMs() < 2000) return { html: rawHtml, method: rawHtml ? 'http_only' : 'unavailable', httpFailure: rawFailure, browserFailure: 'time_budget_exhausted' };
  const dumpBudget = Math.max(1000, Math.min(browserBudgetMs, Math.floor(remainingMs() / 3)));
  const dumpTimeout = Math.max(1000, Math.min(requestTimeoutMs, Math.floor(remainingMs() / 3)));
  const dumped = await renderDumpDom(url, dumpBudget, dumpTimeout);
  if (dumped) return { html: `${rawHtml}\n${dumped}`, method: 'browser_dump_dom', httpFailure: rawFailure };
  return { html: rawHtml, method: rawHtml ? 'http_only' : 'unavailable', httpFailure: rawFailure, browserFailure: 'browser_render_empty' };
}
function extractHtmlLinks(html, siteUrl) {
  const $ = cheerio.load(html); const links = new Map(); const rejected = {};
  $('a[href]').each((_, element) => {
    let absolute; try { absolute = new URL($(element).attr('href'), siteUrl).toString(); } catch { rejected.invalid_url = (rejected.invalid_url || 0) + 1; return; }
    const decision = pageUrlDecision(absolute, siteUrl);
    if (!decision.url) { rejected[decision.reason] = (rejected[decision.reason] || 0) + 1; return; }
    const url = decision.url; if (links.has(url)) return;
    const text = $(element).text().replace(/\s+/g, ' ').trim(); let pagePath = '';
    try { pagePath = decodeURIComponent(new URL(url).pathname); } catch {}
    const hints = `${text} ${pagePath}`;
    const topical = /(?:news|article|announcement|press|media|publication|report|service|initiative|program|project|decision|law|regulation|event|خبر|أخبار|مقال|إعلان|بيان|خدمات|مبادرة|برنامج|مشروع|قرار|قانون|لائحة|حدث|وزارة|محافظة)/i.test(hints);
    links.set(url, { url, text, hasArabic: /[\u0600-\u06FF]/.test(hints), topical, score: (topical ? 5 : 0) + (/[\u0600-\u06FF]/.test(hints) ? 3 : 0) + (pagePath.length > 8 ? 1 : 0) });
  });
  const alternate = htmlArabicAlternateLinks(html, siteUrl, siteUrl);
  for (const [reason, count] of Object.entries(alternate.rejected)) rejected[reason] = (rejected[reason] || 0) + count;
  for (const url of alternate.pages) {
    if (!links.has(url)) links.set(url, { url, text: '', hasArabic: true, topical: false, score: 4 });
  }
  return { links: [...links.values()].sort((a, b) => b.score - a.score), rejected };
}
function isLanguageOnlyUrl(url) {
  try { return /^\/(?:ar|en|fr|de|es|it|ru|zh)(?:\/)?$/i.test(new URL(url).pathname); } catch { return false; }
}
function parseCursor(raw, siteUrl) {
  try {
    const x = JSON.parse(raw || '{}');
    return {
      pendingSitemaps: [...new Set((Array.isArray(x.pendingSitemaps) ? x.pendingSitemaps : []).map(normalizeSitemapUrl).filter(Boolean))],
      seenSitemaps: [...new Set((Array.isArray(x.seenSitemaps) ? x.seenSitemaps : []).map(normalizeSitemapUrl).filter(Boolean))],
      currentSitemap: x.currentSitemap ? normalizeSitemapUrl(x.currentSitemap) || null : null,
      currentPageIndex: Number(x.currentPageIndex) || 0,
    };
  } catch { return { pendingSitemaps: [], seenSitemaps: [], currentSitemap: null, currentPageIndex: 0 }; }
}
function saveCursor(siteId, cursor) { db.prepare('UPDATE sites SET discovery_cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(cursor), siteId); }

async function discoverSite(site) {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM site_pages WHERE site_id=?').get(site.id).count;
  let totalAccepted = existing; let pagesAdded = 0; let sitemapCount = 0;
  const retryNotPages = site.crawl_status === 'not_pages';
  const cursor = retryNotPages
    ? { pendingSitemaps: [], seenSitemaps: [], currentSitemap: null, currentPageIndex: 0 }
    : parseCursor(site.discovery_cursor, site.url);
  cursor.pendingSitemaps = [...new Set(cursor.pendingSitemaps.map(normalizeSitemapUrl).filter(Boolean))];
  const sitemapDiagnostics = [];
  const rejectedPages = {};
  let validSitemaps = 0; let parsedPages = 0; let nestedSitemapsFound = 0;
  const robotsPolicy = await fetchRobotsPolicy(site.url, { timeoutMs: REQUEST_TIMEOUT_MS, productToken: 'BahethMasrDiscovery' });
  const saveBlockedState = () => {
    const state = { ...cursor, robotsStatus: robotsPolicy.denyAll ? 'unreachable_fail_closed' : 'loaded' };
    saveCursor(site.id, state);
    db.prepare('UPDATE sites SET crawl_status=\'pending\',updated_at=CURRENT_TIMESTAMP WHERE id=?').run(site.id);
    return { site_id: site.id, site: site.url, status: 'pending', pages_added: 0, pages_total: totalAccepted, max_pages: MAX_PAGES_PER_SITE, robots_status: state.robotsStatus, reason: 'robots_txt_unreachable_fail_closed' };
  };
  if (robotsPolicy.denyAll) return saveBlockedState();

  const insert = db.prepare("INSERT OR IGNORE INTO site_pages (site_id,url,crawl_status,crawl_attempts) VALUES (?,? ,'pending',0)");
  const insertPage = (url) => {
    if (!isRobotsAllowed(robotsPolicy, url)) return { changes: 0, blocked: true };
    return insert.run(site.id, url);
  };
  const homepage = isPageUrl(site.url, site.url);
  let homepageDocument = null;
  if (homepage && isRobotsAllowed(robotsPolicy, homepage) && totalAccepted < MAX_PAGES_PER_SITE) {
    const result = insertPage(homepage);
    if (result.changes) { pagesAdded += 1; totalAccepted += 1; }
    homepageDocument = await fetchDocument(homepage);
  }
  const seen = new Set(cursor.seenSitemaps);
  const pending = [...cursor.pendingSitemaps];
  let lastCompletedSitemap = cursor.currentSitemap || null;
  let lastCompletedPageIndex = cursor.currentPageIndex || 0;
  for (const rawSitemap of robotsPolicy.sitemaps) {
    const candidate = normalizeSitemapUrl(rawSitemap);
    if (candidate && !seen.has(candidate) && !pending.includes(candidate)) pending.push(candidate);
  }
  const homepageSitemaps = homepageDocument?.ok ? declaredSitemapLinks(homepageDocument.body, homepageDocument.finalUrl, site.url) : [];
  for (const candidate of homepageSitemaps) if (!seen.has(candidate) && !pending.includes(candidate)) pending.push(candidate);
  for (const rawCandidate of sitemapCandidates(site.url)) {
    const candidate = normalizeSitemapUrl(rawCandidate);
    if (candidate && !seen.has(candidate) && !pending.includes(candidate)) pending.push(candidate);
  }
  let current = cursor.currentSitemap;
  let pageIndex = cursor.currentPageIndex;
  while ((current || pending.length) && seen.size < MAX_SITEMAPS) {
    if (!current) { current = pending.shift(); pageIndex = 0; }
    if (seen.has(current) && pageIndex === 0) { current = null; continue; }
    const sitemapPolicy = await fetchRobotsPolicy(current, { timeoutMs: REQUEST_TIMEOUT_MS, productToken: 'BahethMasrDiscovery' });
    if (sitemapPolicy.denyAll || !isRobotsAllowed(sitemapPolicy, current)) {
      sitemapDiagnostics.push({ url: safeUrl(current), outcome: 'skipped', reason: sitemapPolicy.denyAll ? 'robots_unreachable_fail_closed' : 'robots_disallowed' });
      seen.add(current); current = null; pageIndex = 0;
      saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: null, currentPageIndex: 0, sitemapDiagnostics: sitemapDiagnostics.slice(-50) });
      continue;
    }
    const guessedPath = sitemapCandidates(site.url).includes(current);
    const probeTimeout = Math.min(REQUEST_TIMEOUT_MS, Math.max(2500, Number(process.env.DISCOVERY_SITEMAP_PROBE_TIMEOUT_MS || 5000)));
    const document = await fetchDocument(current, { timeoutMs: guessedPath ? probeTimeout : REQUEST_TIMEOUT_MS });
    sitemapCount += 1;
    if (!document.ok) {
      sitemapDiagnostics.push({ url: safeUrl(current), outcome: 'failed', reason: document.reason, http_status: document.status || null, final_url: safeUrl(document.finalUrl) });
      seen.add(current); current = null; pageIndex = 0;
      saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: null, currentPageIndex: 0, sitemapDiagnostics: sitemapDiagnostics.slice(-50) });
      continue;
    }
    const parsed = xmlLinks(document.body, document.finalUrl, site.url);
    let pages = parsed.pages;
    let nestedMaps = parsed.sitemaps;
    let format = parsed.format || '';
    let rejected = parsed.rejected || {};
    if (!parsed.valid) {
      const html = htmlSitemapLinks(document.body, document.finalUrl, site.url);
      const looksLikeHtml = /html/i.test(document.contentType) || /<\s*(?:!doctype\s+html|html\b)/i.test(document.body);
      if (looksLikeHtml && html.linksFound > 0) { pages = html.pages; rejected = html.rejected; format = 'html'; }
      else {
        sitemapDiagnostics.push({ url: safeUrl(current), outcome: 'invalid', reason: 'unrecognized_sitemap_format', http_status: document.status, content_type: document.contentType, bytes: document.bytes });
        seen.add(current); current = null; pageIndex = 0;
        saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: null, currentPageIndex: 0, sitemapDiagnostics: sitemapDiagnostics.slice(-50) });
        continue;
      }
    }
    validSitemaps += 1;
    parsedPages += pages.length;
    for (const [reason, count] of Object.entries(rejected)) rejectedPages[reason] = (rejectedPages[reason] || 0) + count;
    const declaredMaps = declaredSitemapLinks(document.body, document.finalUrl, site.url);
    nestedMaps = [...new Set([...nestedMaps, ...declaredMaps])];
    let nestedAdded = 0;
    for (const nested of nestedMaps) if (!seen.has(nested) && !pending.includes(nested)) { pending.push(nested); nestedAdded += 1; }
    nestedSitemapsFound += nestedMaps.length;
    const attempt = { url: safeUrl(current), outcome: 'parsed', reason: null, http_status: document.status, content_type: document.contentType, bytes: document.bytes, format, pages_found: pages.length, rejected, nested_sitemaps_found: nestedMaps.length, nested_sitemaps_queued: nestedAdded, pages_added: 0 };
    sitemapDiagnostics.push(attempt);
    const pageSlice = pages.slice(pageIndex);
    const allowed = Math.max(0, MAX_PAGES_PER_SITE - totalAccepted);
    if (allowed === 0) { saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current, currentPageIndex: pageIndex, sitemapDiagnostics: sitemapDiagnostics.slice(-50) }); break; }
    const candidates = pageSlice.slice(0, allowed);
    for (let i = 0; i < candidates.length; i += 1) {
      const page = candidates[i];
      if (!isRobotsAllowed(robotsPolicy, page)) { rejectedPages.robots_disallowed = (rejectedPages.robots_disallowed || 0) + 1; continue; }
      const result = insertPage(page); if (result.changes) { pagesAdded += 1; totalAccepted += 1; attempt.pages_added += 1; }
    }
    pageIndex += candidates.length;
    const reachedLimit = totalAccepted >= MAX_PAGES_PER_SITE && pageIndex < pages.length;
    if (reachedLimit) { saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current, currentPageIndex: pageIndex, sitemapDiagnostics: sitemapDiagnostics.slice(-50) }); break; }
    seen.add(current); lastCompletedSitemap = current; lastCompletedPageIndex = pageIndex;
    current = null; pageIndex = 0;
    saveCursor(site.id, { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: lastCompletedSitemap, currentPageIndex: lastCompletedPageIndex, sitemapDiagnostics: sitemapDiagnostics.slice(-50) });
  }
  let feedFallback = { attempted: false, feedsScanned: 0, pagesFound: 0, pagesAdded: 0, failures: [] };
  if (pagesAdded <= 1 && homepage && totalAccepted < MAX_PAGES_PER_SITE) {
    feedFallback.attempted = true;
    const feedSeen = new Set();
    for (const feed of feedCandidates(site.url)) {
      if (totalAccepted >= MAX_PAGES_PER_SITE || feedSeen.has(feed)) break;
      feedSeen.add(feed);
      if (!isRobotsAllowed(robotsPolicy, feed)) {
        feedFallback.feedsScanned += 1;
        feedFallback.failures.push({ url: safeUrl(feed), reason: 'robots_disallowed' });
        continue;
      }
      const response = await fetchDocument(feed, { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, 5000) });
      feedFallback.feedsScanned += 1;
      if (!response.ok) { feedFallback.failures.push({ url: safeUrl(feed), reason: response.reason, http_status: response.status || null }); continue; }
      const parsed = xmlLinks(response.body, response.finalUrl, site.url);
      if (!parsed.valid) { feedFallback.failures.push({ url: safeUrl(feed), reason: 'unrecognized_feed_format', http_status: response.status, content_type: response.contentType }); continue; }
      feedFallback.pagesFound += parsed.pages.length;
      for (const [reason, count] of Object.entries(parsed.rejected || {})) rejectedPages[reason] = (rejectedPages[reason] || 0) + count;
      for (const page of parsed.pages) {
        if (totalAccepted >= MAX_PAGES_PER_SITE) break;
        if (!isRobotsAllowed(robotsPolicy, page)) { rejectedPages.robots_disallowed = (rejectedPages.robots_disallowed || 0) + 1; continue; }
        const result = insertPage(page);
        if (result.changes) { pagesAdded += 1; totalAccepted += 1; feedFallback.pagesAdded += 1; }
      }
    }
  }
  let browserFallback = { attempted: false, pagesVisited: 0, linksFound: 0, linksAdded: 0, contentLinksFound: 0, contentLinksAdded: 0, languageLinksAdded: 0, arabicLinksExpanded: 0, maxDepthReached: 0, renderMethods: {}, failures: [], rejected: {} };
  if (pagesAdded <= 1 && homepage && isRobotsAllowed(robotsPolicy, homepage) && totalAccepted < MAX_PAGES_PER_SITE) {
    browserFallback.attempted = true;
    const deadline = Date.now() + BROWSER_FALLBACK_TOTAL_MS;
    const frontier = [{ url: homepage, depth: 0, document: homepageDocument }];
    const visited = new Set();
    const queued = new Set([homepage]);
    const candidateSeen = new Set();
    const addBrowserPage = (url) => {
      if (!url || totalAccepted >= MAX_PAGES_PER_SITE || !isRobotsAllowed(robotsPolicy, url)) return false;
      queued.add(url);
      const result = insertPage(url);
      if (result.changes) {
        totalAccepted += 1; pagesAdded += 1; browserFallback.linksAdded += 1;
        if (isLanguageOnlyUrl(url)) browserFallback.languageLinksAdded += 1;
        else browserFallback.contentLinksAdded += 1;
      }
      return true;
    };
    while (frontier.length && visited.size < BROWSER_FALLBACK_MAX_PAGES && totalAccepted < MAX_PAGES_PER_SITE && Date.now() < deadline) {
      const page = frontier.shift();
      if (visited.has(page.url) || !isRobotsAllowed(robotsPolicy, page.url)) continue;
      visited.add(page.url);
      const timeLeft = deadline - Date.now();
      const perPageHttpTimeout = Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, Math.floor(timeLeft / 6)));
      const perPageBrowserBudget = Math.max(1000, Math.min(BROWSER_BUDGET_MS, Math.floor(timeLeft / 4)));
      const rendered = await renderPage(page.url, page.document, perPageBrowserBudget, perPageHttpTimeout);
      browserFallback.renderMethods[rendered.method] = (browserFallback.renderMethods[rendered.method] || 0) + 1;
      if (rendered.httpFailure) browserFallback.failures.push({ url: safeUrl(page.url), reason: rendered.httpFailure });
      if (!rendered.html) { browserFallback.failures.push({ url: safeUrl(page.url), reason: 'empty_html' }); continue; }
      browserFallback.pagesVisited += 1;
      browserFallback.maxDepthReached = Math.max(browserFallback.maxDepthReached, page.depth);
      addBrowserPage(page.url);
      const extracted = extractHtmlLinks(rendered.html, page.url);
      for (const [reason, count] of Object.entries(extracted.rejected)) browserFallback.rejected[reason] = (browserFallback.rejected[reason] || 0) + count;
      const contentLinks = extracted.links.filter((link) => !isLanguageOnlyUrl(link.url));
      browserFallback.linksFound += extracted.links.length;
      browserFallback.contentLinksFound += contentLinks.length;
      for (const link of extracted.links) addBrowserPage(link.url);
      if (page.depth >= BROWSER_FALLBACK_MAX_DEPTH) continue;
      for (const link of extracted.links) {
        if (!candidateSeen.has(link.url) && !visited.has(link.url) && isRobotsAllowed(robotsPolicy, link.url)) {
          candidateSeen.add(link.url);
          frontier.push({ url: link.url, depth: page.depth + 1, score: link.score });
        }
      }
      frontier.sort((a, b) => (b.score || 0) - (a.score || 0));
      if (page.depth > 0 && extracted.links.some((link) => link.hasArabic)) browserFallback.arabicLinksExpanded += 1;
    }
    if (frontier.length && Date.now() >= deadline) browserFallback.failures.push({ reason: 'browser_fallback_time_budget_exhausted', remaining_pages: frontier.length });
  }
  const incomplete = totalAccepted >= MAX_PAGES_PER_SITE && (current || pending.length || seen.size >= MAX_SITEMAPS);
  const fallbackFailed = browserFallback.attempted && browserFallback.contentLinksFound === 0;
  const status = fallbackFailed ? 'not_pages' : incomplete ? 'incomplete' : 'completed';
  const finalCursor = { pendingSitemaps: pending, seenSitemaps: [...seen], currentSitemap: current || lastCompletedSitemap, currentPageIndex: current ? pageIndex : lastCompletedPageIndex, sitemapDiagnostics: sitemapDiagnostics.slice(-50), rejectedPages, feedFallback, browserFallback };
  db.prepare('UPDATE sites SET crawl_status=?,discovery_cursor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, JSON.stringify(finalCursor), site.id);
  return { site_id: site.id, site: site.url, status, sitemaps_scanned: sitemapCount, valid_sitemaps: validSitemaps, parsed_pages: parsedPages, nested_sitemaps_found: nestedSitemapsFound, homepage_sitemaps_found: homepageSitemaps.length, sitemap_diagnostics: sitemapDiagnostics.slice(-50), rejected_page_urls: rejectedPages, feeds_scanned: feedFallback.feedsScanned, pages_added: pagesAdded, pages_total: totalAccepted, max_pages: MAX_PAGES_PER_SITE, resume_point_saved: incomplete, feed_fallback: feedFallback, browser_fallback: browserFallback, validation: 'deferred_to_crawler' };
}

const requestedSite = canonicalize(process.env.DISCOVERY_SITE_URL || '');
const statuses = RESUME_INCOMPLETE ? "('pending','incomplete','not_pages')" : "('pending','not_pages')";
const site = requestedSite ? db.prepare(`SELECT id,url,crawl_status,discovery_cursor FROM sites WHERE crawl_status IN ${statuses} AND (url=? OR url=?) LIMIT 1`).get(requestedSite, `${requestedSite}/`) : db.prepare(`SELECT id,url,crawl_status,discovery_cursor FROM sites WHERE crawl_status IN ${statuses} ORDER BY CASE WHEN crawl_status='pending' THEN 0 ELSE 1 END,id LIMIT 1`).get();
if (!site) { console.log(JSON.stringify({ ok: true, message: RESUME_INCOMPLETE ? 'no_pending_or_incomplete_site' : 'no_pending_site', processed_sites: 0 }, null, 2)); db.close(); process.exit(0); }
db.prepare("UPDATE sites SET crawl_status='processing',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id);
try { console.log(JSON.stringify({ ok: true, processed_sites: 1, ...(await discoverSite(site)), resume_incomplete_enabled: RESUME_INCOMPLETE }, null, 2)); } catch (error) { db.prepare("UPDATE sites SET crawl_status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(site.id); console.error(JSON.stringify({ ok: false, site_id: site.id, site: site.url, error: String(error) }, null, 2)); process.exitCode = 1; } finally { db.close(); }

export { canonicalize, isPageUrl, xmlLinks };
