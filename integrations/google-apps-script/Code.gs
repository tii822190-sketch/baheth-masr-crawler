const SHEETS = {
  sites: ['IndexedSites', ['site_id','site_url','canonical_url','title','description','summary','search_snippet','status','first_seen_at','last_crawled_at','source']],
  pages: ['IndexedPages', ['page_id','site_url','page_url','canonical_url','page_type','title','description','summary','search_snippet','http_status','crawl_status','content_hash','last_crawled_at','source_run_id']],
  results: ['CrawlResults', ['result_id','source_run_id','run_type','requested_url','canonical_url','response_url','http_status','crawl_status','content_type','content_length','title','description','summary','search_snippet','icon_url','extracted_text','content_hash','links_json','internal_links_json','external_links_json','social_links_json','discovered_links_count','duration_ms','error_message','fetched_at']],
  discoveries: ['LinkDiscoveries', ['discovery_id','source_run_id','discovered_url','canonical_url','discovery_source','discovered_from_url','title_hint','description_hint','status','discovered_at']]
};

function doGet() { return json_({ ok: true, service: 'baheth-masr-crawler-sheets', sheets: Object.keys(SHEETS) }); }

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.token && body.token !== PropertiesService.getScriptProperties().getProperty('CRAWLER_TOKEN')) return json_({ ok:false, error:'unauthorized' });
    setupSheets_();
    const lock = LockService.getScriptLock(); lock.waitLock(30000);
    try { const counts = appendPayload_(body); return json_({ ok:true, counts }); } finally { lock.releaseLock(); }
  } catch (err) { return json_({ ok:false, error:String(err) }); }
}

function setupSheets() {
  setupSheets_();
  return 'Sheets created: ' + Object.keys(SHEETS).join(', ');
}

function setCrawlerToken(token) { PropertiesService.getScriptProperties().setProperty('CRAWLER_TOKEN', token); }

function setupSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(key => {
    const [name, headers] = SHEETS[key];
    let sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(headers);
    else if (sheet.getRange(1,1,1,headers.length).getValues()[0].join('|') !== headers.join('|')) sheet.getRange(1,1,1,headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1,1,1,headers.length).setFontWeight('bold');
  });
}

function appendPayload_(body) {
  const run = body.run || {};
  const results = Array.isArray(body.results) ? body.results : [];
  const discoveries = Array.isArray(body.discoveries) ? body.discoveries : [];
  const sites = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.sites[0]);
  const pages = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.pages[0]);
  const resultSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.results[0]);
  const discoverySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.discoveries[0]);
  const now = new Date().toISOString();
  const siteRows = [], pageRows = [], resultRows = [], discoveryRows = [];
  results.forEach((r, i) => {
    const siteUrl = r.canonical_url || r.requested_url || '';
    siteRows.push([i + 1, siteUrl, r.canonical_url || '', r.title || '', r.description || '', r.summary || '', r.search_snippet || '', r.crawl_status === 'success' ? 'active' : 'error', now, r.fetched_at || now, 'crawler']);
    resultRows.push([r.id || '', run.source_run_id || run.runId || '', run.run_type || r.run_type || '', r.requested_url || '', r.canonical_url || '', r.response_url || '', r.http_status || '', r.crawl_status || '', r.content_type || '', r.content_length || 0, r.title || '', r.description || '', r.summary || '', r.search_snippet || '', r.icon_url || '', r.extracted_text || '', r.content_hash || '', r.links_json || '[]', r.internal_links_json || '[]', r.external_links_json || '[]', r.social_links_json || '[]', r.discovered_links_count || 0, r.duration_ms || 0, r.error_message || '', r.fetched_at || now]);
    let internal = []; try { internal = JSON.parse(r.internal_links_json || '[]'); } catch (e) {}
    internal.forEach((url, j) => pageRows.push([`${i + 1}-${j + 1}`, siteUrl, url, url, pageType_(url), '', '', '', '', '', 'queued', '', '', run.source_run_id || run.runId || '']));
  });
  discoveries.forEach((d, i) => discoveryRows.push([d.id || i + 1, d.run_id || run.source_run_id || run.runId || '', d.discovered_url || '', d.canonical_url || '', d.discovery_source || '', d.discovered_from_url || '', d.title_hint || '', d.description_hint || '', d.status || 'pending', d.discovered_at || now]));
  appendRows_(sites, uniqueRows_(siteRows, 2)); appendRows_(pages, uniqueRows_(pageRows, 3)); appendRows_(resultSheet, resultRows); appendRows_(discoverySheet, uniqueRows_(discoveryRows, 4));
  return { sites:siteRows.length, pages:pageRows.length, results:resultRows.length, discoveries:discoveryRows.length };
}

function appendRows_(sheet, rows) { if (!rows.length) return; sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows); }
function uniqueRows_(rows, column) { const seen = {}; return rows.filter(row => { const key = String(row[column - 1] || ''); if (seen[key]) return false; seen[key] = true; return true; }); }
function pageType_(url) { if (/\/p\//i.test(url)) return 'public_page'; if (/\/search\/label\//i.test(url)) return 'category'; if (/\/\d{4}\/\d{2}\//.test(url)) return 'article'; return 'internal'; }
function json_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
