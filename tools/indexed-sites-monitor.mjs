import Database from 'better-sqlite3';
import { extractHtml } from '../crawler/src/extract.mjs';
import { canonicalize } from '../crawler/src/db.mjs';
const db = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite');
const timeoutMs = Number(process.env.MONITOR_TIMEOUT_MS || 15000);
const maxSites = Math.max(1, Number(process.env.MONITOR_MAX_SITES || 100));
async function get(url) { const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeoutMs); try { const r=await fetch(url,{signal:c.signal,redirect:'follow',headers:{'user-agent':'BahethMasrMonitor/1.0'}}); return {url:r.url||url,type:r.headers.get('content-type')||'',body:await r.text(),status:r.status}; } catch { return null; } finally { clearTimeout(t); } }
function add(siteId,url) { const c=canonicalize(url); if(!c) return false; try { const result=db.prepare(`INSERT OR IGNORE INTO site_pages (site_id,url,discovered_at,crawl_status) VALUES (?,?,CURRENT_TIMESTAMP,'pending')`).run(siteId,c); return result.changes>0; } catch { return false; } }
const sites=db.prepare(`SELECT s.id,s.url FROM sites s WHERE s.status='active' AND EXISTS (SELECT 1 FROM site_pages p WHERE p.site_id=s.id AND p.crawl_status='indexed') ORDER BY COALESCE(s.last_checked_at,'') ASC,s.id LIMIT ?`).all(maxSites); let checked=0,added=0;
for(const site of sites){ const root=site.url.endsWith('/')?site.url:`${site.url}/`; const sitemap=await get(new URL('/sitemap.xml',root).toString()); if(sitemap?.status<400 && sitemap.type.includes('xml')) { for(const match of sitemap.body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) if(add(site.id,match[1])) added++; } const home=await get(root); if(home?.status<400 && home.type.toLowerCase().includes('html')) { const meta=extractHtml(home.body,home.url,home.type); for(const link of meta.internalLinks) if(add(site.id,link)) added++; } db.prepare('UPDATE sites SET last_checked_at=CURRENT_TIMESTAMP WHERE id=?').run(site.id); db.prepare('UPDATE site_pages SET last_checked_at=CURRENT_TIMESTAMP WHERE site_id=? AND crawl_status=\'indexed\'').run(site.id); checked++; }
console.log(JSON.stringify({ok:true,sites_checked:checked,new_pages_queued:added,monitor_only:true},null,2)); db.close();
