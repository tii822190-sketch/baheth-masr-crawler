import { db, canonicalize } from './db.mjs';
import { extractHtml } from './extract.mjs';

const timeoutMs = Number(process.env.CRAWLER_TIMEOUT_MS || 15000);
const limit = Number(process.env.CRAWLER_LIMIT || 10);
const delayMs = Number(process.env.CRAWLER_DELAY_MS || 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createRun(runType) {
  const r = db.prepare(`INSERT INTO crawl_runs (run_type,status,started_at) VALUES (?, 'running', CURRENT_TIMESTAMP)`).run(runType);
  return r.lastInsertRowid;
}

function targets(runId, runType) {
  const rows = runType === 'weekly_refresh'
    ? db.prepare(`SELECT s.id site_id, s.url, s.priority FROM sites s WHERE s.status='active' ORDER BY s.priority DESC LIMIT ?`).all(limit)
    : db.prepare(`SELECT s.id site_id, s.url, s.priority FROM sites s WHERE s.status='active' ORDER BY s.priority DESC LIMIT ?`).all(limit);
  const insert = db.prepare(`INSERT INTO crawl_targets (run_id,target_type,site_id,url,canonical_url,priority,reason) VALUES (?, 'site', ?, ?, ?, ?, ?)`);
  for (const x of rows) insert.run(runId,x.site_id,x.url,canonicalize(x.url),x.priority,runType);
  db.prepare('UPDATE crawl_runs SET target_count=? WHERE id=?').run(rows.length,runId);
}

async function fetchOne(url) {
  const started = Date.now();
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect:'follow', signal:controller.signal, headers:{'user-agent':'BahethMasrCrawler/0.1 (+staging)'} });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('text/html') ? await response.text() : '';
    return { response, body, contentType, duration:Date.now()-started };
  } catch (e) { return { error:String(e), duration:Date.now()-started }; }
  finally { clearTimeout(timer); }
}

export async function run(runType='daily_check') {
  const runId = createRun(runType); targets(runId, runType);
  const rows = db.prepare(`SELECT * FROM crawl_targets WHERE run_id=? ORDER BY priority DESC,id`).all(runId);
  let success=0, failed=0, changed=0, discovered=0;
  for (const target of rows) {
    db.prepare(`UPDATE crawl_targets SET status='processing',attempts=attempts+1,last_attempt_at=CURRENT_TIMESTAMP WHERE id=?`).run(target.id);
    const result = await fetchOne(target.url);
    let observation;
    if (result.error) { failed++; observation={crawlStatus:'network_error',httpStatus:null,responseUrl:'',contentType:'',body:'',meta:{title:'',description:'',iconUrl:'',extractedText:'',contentHash:'',links:[]},error:result.error}; }
    else {
      const meta = result.body ? extractHtml(result.body, result.response.url) : {title:'',description:'',iconUrl:'',extractedText:'',contentHash:'',links:[]};
      const ok = result.response.status >= 200 && result.response.status < 400;
      ok ? success++ : failed++;
      observation={crawlStatus:ok?'success':'http_error',httpStatus:result.response.status,responseUrl:result.response.url,contentType:result.contentType,body:result.body,meta,error:''};
      if (meta.contentHash) { const old=db.prepare('SELECT content_hash FROM site_pages WHERE site_id=? ORDER BY id LIMIT 1').get(target.site_id); if (old?.content_hash && old.content_hash !== meta.contentHash) changed++; }
      for (const link of meta.links) { const c=canonicalize(link); if (!c || new URL(c).hostname !== new URL(target.url).hostname) continue; const exists=db.prepare('SELECT 1 FROM site_pages WHERE url=? UNION SELECT 1 FROM crawl_discoveries WHERE canonical_url=?').get(link,c); if (!exists) { try { db.prepare(`INSERT INTO crawl_discoveries (run_id,source_site_id,discovered_url,canonical_url,discovery_source,discovered_from_url,title_hint,description_hint) VALUES (?,?,?,?,?,?,?,?)`).run(runId,target.site_id,link,c,'html_link',target.url,meta.title,meta.description); discovered++; } catch {} } }
    }
    db.prepare(`INSERT INTO crawl_observations (target_id,run_id,url,canonical_url,http_status,response_url,crawl_status,content_type,content_length,title,description,icon_url,extracted_text,content_hash,duration_ms,error_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(target.id,runId,target.url,canonicalize(target.url),observation.httpStatus,observation.responseUrl,observation.crawlStatus,observation.contentType,observation.body?.length||0,observation.meta.title,observation.meta.description,observation.meta.iconUrl,observation.meta.extractedText,observation.meta.contentHash,result.duration,observation.error);
    db.prepare(`UPDATE crawl_targets SET status=? WHERE id=?`).run(observation.crawlStatus==='success'?'completed':'failed',target.id); await sleep(delayMs);
  }
  db.prepare(`UPDATE crawl_runs SET status='completed',finished_at=CURRENT_TIMESTAMP,processed_count=?,success_count=?,failed_count=?,changed_count=?,discovered_count=? WHERE id=?`).run(rows.length,success,failed,changed,discovered,runId);
  return {runId,runType,total:rows.length,success,failed,changed,discovered};
}
