import * as cheerio from 'cheerio';
import { canonicalize, db } from './db.mjs';

const timeoutMs = Number(process.env.CRAWLER_TIMEOUT_MS || 15000);
const maxResults = Math.min(Number(process.env.CRAWLER_DDG_MAX_RESULTS || 10), 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ddg(query) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const u = new URL('https://html.duckduckgo.com/html/'); u.searchParams.set('q', query);
    const r = await fetch(u, { signal: controller.signal, headers: { 'user-agent': 'BahethMasrCrawler/0.1 (+staging)' } });
    if (!r.ok) return [];
    const $ = cheerio.load(await r.text()); const out=[];
    $('.result__a').each((_, el) => {
      if (out.length >= maxResults) return;
      const href=$(el).attr('href') || ''; const title=$(el).text().replace(/\s+/g,' ').trim();
      try { const u=new URL(href,'https://html.duckduckgo.com'); const target=u.searchParams.get('uddg') || u.toString(); const c=canonicalize(target); if (c && /^https?:$/.test(new URL(c).protocol)) out.push({url:target,title}); } catch {}
    });
    return out;
  } catch { return []; } finally { clearTimeout(timer); }
}

function addDiscovery(runId, url, source, from='', title='', description='') {
  const canonicalUrl=canonicalize(url); if (!canonicalUrl) return false;
  try { db.prepare(`INSERT INTO crawl_discoveries (run_id,discovered_url,canonical_url,discovery_source,discovered_from_url,title_hint,description_hint) VALUES (?,?,?,?,?,?,?)`).run(runId,url,canonicalUrl,source,from,title,description); return true; } catch { return false; }
}

export async function discover(runId, { queries=[], manualUrl='' }={}) {
  let count=0;
  if (manualUrl) {
    const canonicalUrl = canonicalize(manualUrl);
    if (canonicalUrl) {
      const existing = db.prepare('SELECT id FROM sites WHERE url=?').get(canonicalUrl);
      const siteId = existing?.id ?? db.prepare("INSERT INTO sites (url,name,status,priority) VALUES (?,?, 'active',100)").run(canonicalUrl, new URL(canonicalUrl).hostname).lastInsertRowid;
      try { db.prepare(`INSERT INTO crawl_discoveries (run_id,source_site_id,discovered_url,canonical_url,discovery_source) VALUES (?,?,?,?,?)`).run(runId,siteId,manualUrl,canonicalUrl,'manual'); count++; } catch {}
    }
  }
  for (const query of queries.slice(0,3)) { for (const hit of await ddg(query)) count += addDiscovery(runId,hit.url,'duckduckgo',`https://duckduckgo.com/?q=${encodeURIComponent(query)}`,hit.title) ? 1 : 0; await sleep(1200); }
  return count;
}
