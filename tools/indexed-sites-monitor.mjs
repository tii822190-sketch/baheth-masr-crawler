import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { extractHtml } from '../crawler/src/extract.mjs';
import { canonicalize } from '../crawler/src/db.mjs';

const db = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite');
const timeoutMs = Number(process.env.MONITOR_TIMEOUT_MS || 20000);
const maxSites = Math.max(1, Number(process.env.MONITOR_MAX_SITES || 100));
const maxNewPages = Math.max(1, Number(process.env.MONITOR_MAX_NEW_PAGES || 1000));
const browserBudgetMs = Math.max(1000, Number(process.env.MONITOR_BROWSER_BUDGET_MS || 12000));
const blocked = /\.(?:7z|apk|avi|bin|css|csv|docx?|exe|gif|iso|jpe?g|js|m3u8|mp3|mp4|pdf|png|pptx?|rar|svg|tar|webp|woff2?|xlsx?|zip)(?:$|[?#])/i;

function sameHost(a, b) { try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; } }
function allowed(url, root) { try { const u = new URL(url, root); return /^https?:$/.test(u.protocol) && !blocked.test(u.pathname) && sameHost(root, u.toString()); } catch { return false; } }
async function text(url) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'BahethMasrMonitor/2.0 (+sitemap-monitor)' } }); if (!r.ok) return ''; const bytes = Buffer.from(await r.arrayBuffer()); return url.endsWith('.gz') || (bytes[0] === 0x1f && bytes[1] === 0x8b) ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'); } catch { return ''; } finally { clearTimeout(timer); }
}
async function browserHtml(url) { return await new Promise((resolve) => { const child = spawn('/usr/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--virtual-time-budget=${browserBudgetMs}`,'--dump-dom',url], { stdio: ['ignore','pipe','ignore'] }); let body = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(''); }, timeoutMs + browserBudgetMs); child.stdout.on('data', (chunk) => { body += chunk; }); child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? body : ''); }); }); }
function add(siteId, root, url) { if (!allowed(url, root)) return false; const c = canonicalize(new URL(url, root).toString()); if (!c) return false; try { return db.prepare(`INSERT OR IGNORE INTO site_pages (site_id,url,discovered_at,crawl_status) VALUES (?,?,CURRENT_TIMESTAMP,'pending')`).run(siteId, c).changes > 0; } catch { return false; } }
async function sitemapPages(siteId, root) {
  const origin = new URL(root).origin; const candidates = new Set([`${origin}/robots.txt`,`${origin}/sitemap.xml`,`${origin}/sitemap_index.xml`,`${origin}/sitemap-index.xml`,`${origin}/sitemap/sitemap.xml`,`${origin}/post-sitemap.xml`,`${origin}/page-sitemap.xml`]);
  const robots = await text(`${origin}/robots.txt`); for (const line of robots.split(/\r?\n/)) { const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i); if (m) candidates.add(m[1]); }
  const pending = [...candidates]; const seen = new Set(); let added = 0;
  while (pending.length && seen.size < 100 && added < maxNewPages) { const map = pending.shift(); if (seen.has(map)) continue; seen.add(map); const body = await text(map); if (!body || /\/robots\.txt$/i.test(map)) continue; const locs = /<(?:urlset|sitemapindex)\b/i.test(body) ? [...body.matchAll(/<loc[^>]*>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim()) : body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); const index = /<sitemapindex\b/i.test(body); for (const raw of locs) { let url; try { url = new URL(raw, map).toString(); } catch { continue; } if (!allowed(url, root)) continue; if (index || /sitemap(?:[-_].*)?\.xml(?:\.gz)?$/i.test(url)) pending.push(url); else if (add(siteId, root, url)) added += 1; if (added >= maxNewPages) break; } }
  return { added, maps: seen.size };
}
const sites = db.prepare(`SELECT s.id,s.url FROM sites s WHERE s.status='active' AND s.discovery_status='completed' AND EXISTS (SELECT 1 FROM site_pages p WHERE p.site_id=s.id AND p.crawl_status='indexed') AND NOT EXISTS (SELECT 1 FROM site_pages p WHERE p.site_id=s.id AND COALESCE(p.crawl_status,'pending') NOT IN ('indexed','success','crawled')) ORDER BY COALESCE(s.last_checked_at,'') ASC,s.id LIMIT ?`).all(maxSites);
let checked = 0; let added = 0; const details = [];
for (const site of sites) { const root = site.url.endsWith('/') ? site.url : `${site.url}/`; try { const result = await sitemapPages(site.id, root); let siteAdded = result.added; if (!siteAdded) { const home = (await text(root)) || await browserHtml(root); if (home) { const meta = extractHtml(home, root, 'text/html'); for (const link of meta.internalLinks) { if (add(site.id, root, link)) { siteAdded += 1; if (siteAdded >= maxNewPages) break; } } } } db.prepare('UPDATE sites SET last_checked_at=CURRENT_TIMESTAMP WHERE id=?').run(site.id); db.prepare("UPDATE site_pages SET last_checked_at=CURRENT_TIMESTAMP WHERE site_id=? AND crawl_status='indexed'").run(site.id); checked += 1; added += siteAdded; details.push({ site: root, sitemaps: result.maps, new_pages: siteAdded }); } catch (error) { db.prepare('UPDATE sites SET last_checked_at=CURRENT_TIMESTAMP WHERE id=?').run(site.id); details.push({ site: root, error: String(error).slice(0, 300) }); } }
console.log(JSON.stringify({ ok: true, sites_checked: checked, new_pages_queued: added, max_new_pages: maxNewPages, details, monitor_only: true }, null, 2)); db.close();
