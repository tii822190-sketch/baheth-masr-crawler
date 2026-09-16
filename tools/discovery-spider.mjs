import Database from 'better-sqlite3';
import { extractHtml } from '../crawler/src/extract.mjs';
import { canonicalize } from '../crawler/src/db.mjs';

const links = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite');
const timeoutMs = Number(process.env.DISCOVERY_TIMEOUT_MS || 20000);
const perSite = Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES_PER_SITE || 500));
const maxSites = Math.max(1, Number(process.env.DISCOVERY_MAX_SITES || 25));
const allowedTlds = new Set(['eg','com','net','org','edu','gov','ai','jp']);
const blocked = /\.(?:7z|apk|avi|bin|css|csv|docx?|exe|gif|iso|jpe?g|js|m3u8|mp3|mp4|pdf|png|pptx?|rar|svg|tar|webp|woff2?|xlsx?|zip)(?:$|[?#])/i;
function allowed(url) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || blocked.test(u.pathname) || /^(mailto|tel|javascript):/i.test(url)) return false; const labels = u.hostname.toLowerCase().split('.'); return labels.length >= 2 && allowedTlds.has(labels.at(-1)); } catch { return false; } }
async function fetchHtml(url) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { const r = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'BahethMasrDiscovery/1.0' } }); const type = r.headers.get('content-type') || ''; if (!r.ok || !type.toLowerCase().includes('html')) return null; return { url: r.url || url, body: await r.text(), type }; } catch { return null; } finally { clearTimeout(timer); } }
function sameHost(a,b) { try { return new URL(a).hostname.replace(/^www\./,'') === new URL(b).hostname.replace(/^www\./,''); } catch { return false; } }
function addPage(siteId, url) { const c = canonicalize(url); if (!c || !allowed(c)) return false; try { links.prepare(`INSERT OR IGNORE INTO site_pages (site_id,url,discovered_at,crawl_status) VALUES (?,?,CURRENT_TIMESTAMP,'pending')`).run(siteId, c); return true; } catch { return false; } }
function addSite(url) { const c = canonicalize(url); if (!c || !allowed(c)) return null; const u = new URL(c); const root = `${u.protocol}//${u.host}/`; const found = links.prepare('SELECT id FROM sites WHERE url=? OR url=?').get(root, c); if (found) return found.id; return links.prepare(`INSERT INTO sites (url,name,status,priority,discovery_status,last_discovered_at) VALUES (?,?, 'active',50,'pending',CURRENT_TIMESTAMP)`).run(root,u.hostname).lastInsertRowid; }
const sites = links.prepare(`SELECT id,url FROM sites WHERE COALESCE(discovery_status,'active')='pending' ORDER BY COALESCE(last_discovered_at,'') ASC,id LIMIT ?`).all(maxSites);
let siteCount=0,pageCount=0,externalSites=0;
for (const site of sites) { const queue=[site.url], seen=new Set(); let discovered=0; while(queue.length && discovered<perSite) { const current=queue.shift(); const c=canonicalize(current); if(!c || seen.has(c)) continue; seen.add(c); const response=await fetchHtml(c); if(!response) continue; const meta=extractHtml(response.body,response.url,response.type); if (sameHost(site.url,response.url)) { if(addPage(site.id,response.url)) pageCount++; discovered++; for (const link of meta.internalLinks) { const normalized=canonicalize(link); if(normalized && sameHost(site.url,normalized) && !seen.has(normalized)) queue.push(normalized); } for (const link of meta.externalLinks) { const normalized=canonicalize(link); if(normalized && allowed(normalized)) { const newSite=addSite(normalized); if(newSite && newSite !== site.id) { externalSites++; addPage(newSite,normalized); } } } } }
 links.prepare('UPDATE sites SET discovery_status=\'active\',last_discovered_at=CURRENT_TIMESTAMP WHERE id=?').run(site.id); siteCount++; }
console.log(JSON.stringify({ok:true,sites_scanned:siteCount,pages_queued:pageCount,external_sites_registered:externalSites,discovery_only:true},null,2)); links.close();
