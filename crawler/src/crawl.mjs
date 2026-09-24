import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { db, canonicalize } from './db.mjs';
import { extractHtml } from './extract.mjs';
import taxonomy from '../../taxonomy/search-taxonomy.json' with { type: 'json' };

const batchSize = Math.max(1, Number(process.env.CRAWLER_BATCH_SIZE || 20));
const maxPages = Math.max(1, Number(process.env.CRAWLER_MAX_PAGES || batchSize));
const concurrency = Math.max(1, Math.min(10, Number(process.env.CRAWLER_CONCURRENCY || 10)));
const browserConcurrency = Math.max(1, Math.min(concurrency, Number(process.env.CRAWLER_BROWSER_CONCURRENCY || Math.min(3, concurrency))));
const retries = Math.max(0, Number(process.env.CRAWLER_RETRIES || 1));
const pageTimeoutMs = Math.max(1000, Number(process.env.CRAWLER_PAGE_TIMEOUT_MS || 120000));
const browserBudgetMs = Math.max(1000, Number(process.env.CRAWLER_BROWSER_BUDGET_MS || 15000));
const fetchMode = process.env.CRAWLER_FETCH_MODE || 'hybrid';
const retryLimit = Math.max(1, Number(process.env.CRAWLER_REVIEW_RETRIES || 1));
const minExtractedTextChars = Math.max(20, Number(process.env.CRAWLER_MIN_EXTRACTED_TEXT_CHARS || 80));
const REQUIRED_METADATA_FIELDS = ['url', 'title', 'description', 'iconUrl', 'keywords', 'snippet'];
const browserBinary = process.env.CRAWLER_BROWSER_BIN || [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].find((candidate) => fs.existsSync(candidate)) || 'chromium';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function acquireBatch() {
  db.prepare("UPDATE site_pages SET crawl_status='pending' WHERE crawl_status='processing'").run();
  const pending = db.prepare(`
    SELECT id,site_id,url,crawl_status,crawl_attempts
    FROM site_pages
    WHERE COALESCE(crawl_status,'pending') IN ('pending','queued')
    ORDER BY id
    LIMIT ?
  `).all(Math.min(batchSize, maxPages));
  const candidates = pending.length ? pending : db.prepare(`
    SELECT id,site_id,url,crawl_status,crawl_attempts
    FROM site_pages
    WHERE COALESCE(crawl_status,'needs_review')='needs_review'
      AND COALESCE(crawl_attempts,0) < ?
    ORDER BY id
    LIMIT ?
  `).all(retryLimit + 1, Math.min(batchSize, maxPages));
  if (!candidates.length) {
    return { targets: [], phase: pending.length ? 'pending' : 'review' };
  }
  const mark = db.prepare(`UPDATE site_pages SET crawl_status='processing', crawl_attempts=COALESCE(crawl_attempts,0)+1 WHERE id=?`);
  for (const page of candidates) mark.run(page.id);
  return { targets: candidates, phase: pending.length ? 'pending' : 'review' };
}

function acquireBrowserSlot(state) {
  if (state.active < state.limit) { state.active += 1; return Promise.resolve(); }
  return new Promise((resolve) => state.waiters.push(resolve));
}
function releaseBrowserSlot(state) {
  state.active -= 1;
  state.waiters.shift()?.();
}

async function browserFetch(url, browserState) {
  await acquireBrowserSlot(browserState);
  try {
    return await new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(browserBinary, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        `--virtual-time-budget=${browserBudgetMs}`, '--run-all-compositor-stages-before-draw', '--dump-dom', url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let body = '';
      let error = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('browser_timeout')); }, pageTimeoutMs);
      child.stdout.on('data', (chunk) => { body += chunk; });
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.once('error', (spawnError) => { clearTimeout(timer); reject(spawnError); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && body.trim()) resolve({ url, responseUrl: url, status: 200, contentType: 'text/html', body, duration: Date.now() - started, method: 'browser' });
        else reject(new Error(error.trim().slice(-300) || `browser_exit_${code}`));
      });
    });
  } finally {
    releaseBrowserSlot(browserState);
  }
}

async function httpFetch(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pageTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'BahethMasrCrawler/1.0' } });
    return { url, responseUrl: response.url || url, status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text(), duration: Date.now() - started, method: 'http' };
  } finally {
    clearTimeout(timer);
  }
}

export function shouldUseBrowserFallback(result, meta) {
  const contentType = String(result?.contentType || '').toLowerCase();
  const extractedTextLength = String(meta?.extractedText || '').trim().length;
  return Number(result?.status || 0) >= 400
    || !contentType.includes('html')
    || String(result?.body || '').length < 200
    || meta?.qualityStatus === 'dynamic_content'
    || meta?.qualityStatus === 'thin_content'
    || meta?.qualityStatus === 'blocked_challenge'
    || extractedTextLength < minExtractedTextChars;
}

export async function fetchOne(url, browserState, { httpFetcher = httpFetch, browserFetcher = browserFetch } = {}) {
  let lastError = '';
  let fetchAttempts = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    fetchAttempts = attempt + 1;
    try {
      if (fetchMode === 'browser') return { ...(await browserFetcher(url, browserState)), fetchAttempts };
      const httpStarted = Date.now();
      let http;
      try {
        http = { ...(await httpFetcher(url)), fetchAttempts };
      } catch (httpError) {
        if (fetchMode !== 'hybrid') throw httpError;
        const httpFetchError = String(httpError).slice(0, 500);
        const httpFetchErrorCode = httpError?.name === 'AbortError' || /timeout/i.test(httpFetchError) ? 'timeout' : 'fetch_error';
        try {
          const browser = await browserFetcher(url, browserState);
          return {
            ...browser,
            fetchAttempts,
            browserFallbackAttempted: true,
            browserFallbackChoice: 'browser',
            httpFetchError,
            httpFetchErrorCode,
            httpDurationMs: Date.now() - httpStarted,
          };
        } catch (browserError) {
          const browserFallbackError = String(browserError).slice(0, 500);
          lastError = `http_${httpFetchErrorCode}: ${httpFetchError}; browser_fallback_error: ${browserFallbackError}`;
          if (attempt < retries) {
            await sleep(Math.min(5000, 500 * (attempt + 1)));
            continue;
          }
          return {
            url,
            responseUrl: '',
            status: 0,
            contentType: '',
            body: '',
            duration: Date.now() - httpStarted,
            method: fetchMode,
            fetchAttempts,
            error: lastError,
            browserFallbackAttempted: true,
            browserFallbackError,
            httpFetchError,
            httpFetchErrorCode,
          };
        }
      }
      if (fetchMode === 'hybrid') {
        const httpMeta = extractHtml(http.body, http.responseUrl || http.url, http.contentType || 'text/html');
        if (shouldUseBrowserFallback(http, httpMeta)) {
          try {
            const browser = await browserFetcher(url, browserState);
            const browserMeta = extractHtml(browser.body, browser.responseUrl || browser.url, browser.contentType || 'text/html');
            const httpTextLength = String(httpMeta.extractedText || '').trim().length;
            const browserTextLength = String(browserMeta.extractedText || '').trim().length;
            if (browserTextLength > httpTextLength) {
              return { ...browser, fetchAttempts, browserFallbackAttempted: true, browserFallbackFromStatus: http.status, browserFallbackChoice: 'browser', browserFallbackHttpTextLength: httpTextLength, browserFallbackRenderedTextLength: browserTextLength, httpDurationMs: http.duration };
            }
            return { ...http, browserFallbackAttempted: true, browserFallbackChoice: 'http', browserFallbackHttpTextLength: httpTextLength, browserFallbackRenderedTextLength: browserTextLength, browserFallbackError: 'rendered_text_not_improved' };
          } catch (error) {
            return { ...http, browserFallbackAttempted: true, browserFallbackChoice: 'http', browserFallbackError: String(error).slice(0, 240) };
          }
        }
      }
      return http;
    } catch (error) {
      lastError = String(error);
      if (attempt < retries) await sleep(Math.min(5000, 500 * (attempt + 1)));
    }
  }
  return { url, responseUrl: '', status: 0, contentType: '', body: '', duration: pageTimeoutMs, method: fetchMode, fetchAttempts, error: lastError };
}

async function mapLimit(items, worker, limit) {
  const output = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return output;
}

function clean(value, max = 250) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
export function errorCode(result = {}, output = {}) {
  if (result.error) return String(result.error).includes('timeout') ? 'timeout' : 'fetch_error';
  if (output.httpStatus === 404) return 'not_found';
  if (output.httpStatus === 403) return 'forbidden';
  if (output.httpStatus === 429) return 'rate_limited';
  if (output.httpStatus >= 400) return `http_${output.httpStatus}`;
  if (!String(output.contentType || '').toLowerCase().includes('html')) return 'not_html';
  if (output.meta?.qualityStatus && output.meta.qualityStatus !== 'good') return output.meta.qualityStatus;
  return 'unknown';
}
function mergedKeywords(meta) {
  const category = taxonomy.categories.find((item) => item.id === meta.categoryCandidate);
  const subcategories = (meta.subcategoryCandidates || []).map((id) => category?.subcategories?.find((item) => item.id === id)).filter(Boolean);
  const values = [category?.name_ar, ...(category?.keywords_ar || []), ...subcategories.map((item) => item.name_ar), ...subcategories.flatMap((item) => item.keywords_ar || []), ...(meta.classificationReasons || []).map((item) => item.keyword)];
  return [...new Set(values.map((value) => clean(value, 80)).filter(Boolean))].join('، ');
}
function compactMeta(result) {
  const meta = extractHtml(result.body, result.responseUrl || result.url, result.contentType || 'text/html');
  return {
    url: canonicalize(result.responseUrl || result.url) || result.url,
    title: clean(meta.title),
    description: clean(meta.description),
    iconUrl: clean(meta.iconUrl, 1000),
    keywords: mergedKeywords(meta),
    snippet: clean(meta.searchSnippet || meta.summary || meta.description),
    qualityStatus: meta.qualityStatus || 'unknown',
    extractedTextLength: String(meta.extractedText || '').trim().length,
    extractedTextExcerpt: clean(meta.extractedText, 300),
  };
}
export function isComplete(result, meta) {
  if (result.error || result.status < 200 || result.status >= 400 || !result.contentType.toLowerCase().includes('html')) return false;
  if (meta.qualityStatus !== 'good' || Number(meta.extractedTextLength || 0) < minExtractedTextChars) return false;
  return REQUIRED_METADATA_FIELDS.every((field) => Boolean(meta[field]));
}

export function diagnoseReview(result, meta) {
  const missingFields = REQUIRED_METADATA_FIELDS.filter((field) => !meta[field]);
  const extractedTextLength = Number(meta.extractedTextLength || 0);
  let reason = 'unknown';
  if (result.error) reason = String(result.error).includes('timeout') ? 'fetch_timeout' : 'fetch_error';
  else if (result.status === 403) reason = 'http_403';
  else if (result.status === 404) reason = 'http_404';
  else if (result.status === 429) reason = 'http_429';
  else if (result.status < 200 || result.status >= 400) reason = `http_${result.status || 'unknown'}`;
  else if (!String(result.contentType || '').toLowerCase().includes('html')) reason = 'not_html';
  else if (meta.qualityStatus && meta.qualityStatus !== 'good') reason = meta.qualityStatus;
  else if (extractedTextLength < minExtractedTextChars) reason = 'insufficient_extracted_text';
  else if (missingFields.length) reason = `missing_${missingFields.join('_')}`;
  else if (result.browserFallbackError) reason = 'browser_fallback_failed';
  return {
    reason,
    missingFields,
    qualityStatus: meta.qualityStatus || 'unknown',
    extractedTextLength,
    extractedTextExcerpt: String(meta.extractedTextExcerpt || '').slice(0, 300),
    observedMetadata: Object.fromEntries(['url', 'title', 'description', 'iconUrl', 'keywords', 'snippet'].map((field) => [field, String(meta[field] || '').slice(0, field === 'snippet' ? 320 : 500)])),
    ...fetchTrace(result),
    ...(result.error ? { error: String(result.error).slice(0, 500) } : {}),
  };
}
function fetchTrace(result) {
  return {
    httpStatus: Number(result.status || 0),
    contentType: String(result.contentType || '').slice(0, 100),
    responseUrl: String(result.responseUrl || result.url || '').slice(0, 1000),
    fetchMethod: result.method || fetchMode,
    durationMs: Number(result.duration || 0),
    fetchAttempts: Number(result.fetchAttempts || 0),
    pageAttempt: Number(result.pageAttempt || 0),
    browserFallbackAttempted: Boolean(result.browserFallbackAttempted),
    ...(result.browserFallbackChoice ? { browserFallbackChoice: result.browserFallbackChoice } : {}),
    ...(result.browserFallbackFromStatus ? { browserFallbackFromStatus: result.browserFallbackFromStatus } : {}),
    ...(Number.isFinite(result.httpDurationMs) ? { httpDurationMs: Number(result.httpDurationMs) } : {}),
    ...(Number.isFinite(result.browserFallbackHttpTextLength) ? { browserFallbackHttpTextLength: Number(result.browserFallbackHttpTextLength) } : {}),
    ...(Number.isFinite(result.browserFallbackRenderedTextLength) ? { browserFallbackRenderedTextLength: Number(result.browserFallbackRenderedTextLength) } : {}),
    ...(result.browserFallbackError ? { browserFallbackError: result.browserFallbackError } : {}),
    ...(result.httpFetchError ? { httpFetchError: result.httpFetchError } : {}),
    ...(result.httpFetchErrorCode ? { httpFetchErrorCode: result.httpFetchErrorCode } : {}),
  };
}
function saveSuccessful(meta) {
  db.prepare(`
    INSERT INTO index_results (url,title,description,icon_url,keywords,snippet,updated_at)
    VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(url) DO UPDATE SET
      title=excluded.title, description=excluded.description, icon_url=excluded.icon_url,
      keywords=excluded.keywords, snippet=excluded.snippet, updated_at=CURRENT_TIMESTAMP
  `).run(meta.url, meta.title, meta.description, meta.iconUrl, meta.keywords, meta.snippet);
}
function removeFromQueue(pageId) {
  db.prepare('DELETE FROM site_pages WHERE id=?').run(pageId);
}
function markNeedsReview(page) {
  db.prepare(`UPDATE site_pages SET crawl_status='needs_review' WHERE id=?`).run(page.id);
}
function markCorrupt(page) {
  db.prepare(`UPDATE site_pages SET crawl_status='corrupt' WHERE id=?`).run(page.id);
  removeFromQueue(page.id);
}

function emitPageProgress(event) {
  const line = JSON.stringify({ type: 'crawler_page', ...event });
  process.stderr.write(`[crawler] ${line}\n`);
  const logPath = process.env.CRAWLER_PROGRESS_LOG_PATH;
  if (logPath) fs.appendFileSync(logPath, `${line}\n`);
}

export async function run(type = 'manual') {
  const browserState = { active: 0, limit: browserConcurrency, waiters: [] };
  const { targets, phase } = acquireBatch();
  let success = 0; let review = 0; let corrupt = 0;
  const failureReasons = {};
  await mapLimit(targets, async (page) => {
    const result = await fetchOne(page.url, browserState);
    result.pageAttempt = (page.crawl_attempts || 0) + 1;
    let meta = null;
    try { meta = compactMeta(result); } catch { meta = null; }
    let pageEvent;
    if (meta && isComplete(result, meta)) {
      saveSuccessful(meta);
      removeFromQueue(page.id);
      success += 1;
      pageEvent = {
        url: page.url,
        outcome: 'indexed',
        request: fetchTrace(result),
        extracted: {
          canonicalUrl: meta.url,
          title: meta.title,
          description: meta.description,
          iconUrl: meta.iconUrl,
          keywords: meta.keywords,
          snippet: meta.snippet,
        },
      };
    } else {
      const diagnosis = diagnoseReview(result, meta || {});
      failureReasons[diagnosis.reason] = (failureReasons[diagnosis.reason] || 0) + 1;
      if (phase === 'review' || (page.crawl_attempts || 0) >= retryLimit + 1) {
        markCorrupt(page);
        corrupt += 1;
        pageEvent = { url: page.url, outcome: 'corrupt', diagnostics: diagnosis };
      } else {
        markNeedsReview(page);
        review += 1;
        pageEvent = { url: page.url, outcome: 'needs_review', diagnostics: diagnosis };
      }
    }
    emitPageProgress(pageEvent);
  }, concurrency);
  return { phase, total: targets.length, success, needs_review: review, failure_reasons: failureReasons, corrupt, batch_size: batchSize, concurrency, browser_concurrency: browserConcurrency, retries, fetch_mode: fetchMode };
}
