import { spawn } from 'node:child_process';
import { db, canonicalize } from './db.mjs';
import { extractHtml } from './extract.mjs';
import taxonomy from '../../taxonomy/search-taxonomy.json' with { type: 'json' };

const batchSize = Math.max(1, Number(process.env.CRAWLER_BATCH_SIZE || 20));
const maxPages = Math.max(1, Number(process.env.CRAWLER_MAX_PAGES || batchSize));
const concurrency = Math.max(1, Math.min(10, Number(process.env.CRAWLER_CONCURRENCY || 10)));
const retries = Math.max(0, Number(process.env.CRAWLER_RETRIES || 1));
const pageTimeoutMs = Math.max(1000, Number(process.env.CRAWLER_PAGE_TIMEOUT_MS || 120000));
const browserBudgetMs = Math.max(1000, Number(process.env.CRAWLER_BROWSER_BUDGET_MS || 15000));
const fetchMode = process.env.CRAWLER_FETCH_MODE || 'hybrid';
const retryLimit = Math.max(1, Number(process.env.CRAWLER_REVIEW_RETRIES || 1));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRun(type) {
  return db.prepare(`INSERT INTO crawl_runs (run_type,status,started_at,target_count) VALUES (?, 'running', CURRENT_TIMESTAMP, 0)`).run(type).lastInsertRowid;
}

function acquireBatch(runId) {
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
    db.prepare('UPDATE crawl_runs SET target_count=0 WHERE id=?').run(runId);
    return { targets: [], phase: pending.length ? 'pending' : 'review' };
  }
  const mark = db.prepare(`UPDATE site_pages SET crawl_status='processing', crawl_attempts=COALESCE(crawl_attempts,0)+1 WHERE id=?`);
  for (const page of candidates) mark.run(page.id);
  db.prepare('UPDATE crawl_runs SET target_count=? WHERE id=?').run(candidates.length, runId);
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
      const child = spawn('/usr/bin/chromium', [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        `--virtual-time-budget=${browserBudgetMs}`, '--run-all-compositor-stages-before-draw', '--dump-dom', url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let body = '';
      let error = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('browser_timeout')); }, pageTimeoutMs);
      child.stdout.on('data', (chunk) => { body += chunk; });
      child.stderr.on('data', (chunk) => { error += chunk; });
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
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'BahethMasrCrawler/1.0 (+staging)' } });
    return { url, responseUrl: response.url || url, status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text(), duration: Date.now() - started, method: 'http' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(url, browserState) {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (fetchMode === 'browser') return await browserFetch(url, browserState);
      const http = await httpFetch(url);
      if (fetchMode === 'hybrid' && (http.status >= 400 || !http.contentType.toLowerCase().includes('html') || http.body.length < 200)) {
        try { return await browserFetch(url, browserState); } catch { return http; }
      }
      return http;
    } catch (error) {
      lastError = String(error);
      if (attempt < retries) await sleep(Math.min(5000, 500 * (attempt + 1)));
    }
  }
  return { url, responseUrl: '', status: 0, contentType: '', body: '', duration: pageTimeoutMs, method: fetchMode, error: lastError };
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
  };
}
function isComplete(result, meta) {
  if (result.error || result.status < 200 || result.status >= 400 || !result.contentType.toLowerCase().includes('html')) return false;
  return Boolean(meta.url && meta.title && meta.description && meta.iconUrl && meta.keywords && meta.snippet);
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
  db.prepare('DELETE FROM crawl_observations WHERE target_id IN (SELECT id FROM crawl_targets WHERE page_id=?)').run(pageId);
  db.prepare('DELETE FROM crawl_targets WHERE page_id=?').run(pageId);
  db.prepare('DELETE FROM site_pages WHERE id=?').run(pageId);
}
function markNeedsReview(page, result) {
  db.prepare(`UPDATE site_pages SET crawl_status='needs_review', http_status=?, description=?, content_hash=? WHERE id=?`)
    .run(result.status || null, result.error || 'بيانات ناقصة أو فشل الجلب', '', page.id);
}
function markCorrupt(page, result) {
  db.prepare(`UPDATE site_pages SET crawl_status='corrupt', http_status=?, description=? WHERE id=?`)
    .run(result.status || null, result.error || 'فشل بعد المحاولة الأخيرة', page.id);
  removeFromQueue(page.id);
}

export async function run(type = 'manual') {
  const runId = createRun(type);
  const browserState = { active: 0, limit: 7, waiters: [] };
  const { targets, phase } = acquireBatch(runId);
  let success = 0; let review = 0; let corrupt = 0;
  const fetched = await mapLimit(targets, (page) => fetchOne(page.url, browserState), concurrency);
  for (let i = 0; i < targets.length; i += 1) {
    const page = targets[i];
    const result = fetched[i];
    let meta = null;
    try { meta = compactMeta(result); } catch { meta = null; }
    if (meta && isComplete(result, meta)) {
      saveSuccessful(meta);
      removeFromQueue(page.id);
      success += 1;
    } else if (phase === 'review' || (page.crawl_attempts || 0) >= retryLimit + 1) {
      markCorrupt(page, result);
      corrupt += 1;
    } else {
      markNeedsReview(page, result);
      review += 1;
    }
  }
  db.prepare(`UPDATE crawl_runs SET status='completed',finished_at=CURRENT_TIMESTAMP,processed_count=?,success_count=?,failed_count=? WHERE id=?`).run(targets.length, success, review + corrupt, runId);
  return { runId, phase, total: targets.length, success, needs_review: review, corrupt, batch_size: batchSize, concurrency, retries, fetch_mode: fetchMode };
}
