const raw=process.env.TURSO_PRODUCTION_DATABASE_URL,token=process.env.TURSO_PRODUCTION_AUTH_TOKEN;
if(!raw||!token)throw new Error('TURSO_PRODUCTION_DATABASE_URL and TURSO_PRODUCTION_AUTH_TOKEN are required');
const base=raw.replace(/^libsql:\/\//,'https://').replace(/^turso:\/\//,'https://').replace(/\/$/,'');
const requests=[
 {type:'execute',stmt:{sql:'SELECT 1 AS health'}},
 {type:'execute',stmt:{sql:"SELECT name,type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type,name"}},
 {type:'execute',stmt:{sql:'PRAGMA table_info(sites)'}},
 {type:'execute',stmt:{sql:'PRAGMA table_info(site_pages)'}},
 {type:'execute',stmt:{sql:'PRAGMA table_info(site_search_fts)'}},
 {type:'execute',stmt:{sql:"SELECT id,site_id,url,canonical_url,title,status,http_status,crawl_status FROM site_pages WHERE title LIKE '%EgyptSchools%' OR url LIKE '%egyptschools%' OR canonical_url LIKE '%egyptschools%'"}},
 {type:'execute',stmt:{sql:"SELECT record_type,record_id,site_id,title,description FROM site_search_fts WHERE title LIKE '%EgyptSchools%' OR record_id IN (SELECT CAST(id AS TEXT) FROM site_pages WHERE title LIKE '%EgyptSchools%' OR url LIKE '%egyptschools%')"}},
 {type:'execute',stmt:{sql:"SELECT id,name,url,canonical_url,status FROM sites WHERE name LIKE '%EgyptSchools%' OR url LIKE '%egyptschools%' OR canonical_url LIKE '%egyptschools%'"}},
 {type:'execute',stmt:{sql:'SELECT id,site_id,url,canonical_url,title,status FROM site_pages ORDER BY id DESC LIMIT 10'}},
 {type:'execute',stmt:{sql:'PRAGMA foreign_key_list(site_pages)'}},
 {type:'close'}
];
const response=await fetch(`${base}/v2/pipeline`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests})});
const body=await response.json();
if(!response.ok)throw new Error(`Production HTTP ${response.status}`);
const errors=(body.results||[]).filter(x=>x.type==='error'||x.response?.error);if(errors.length)throw new Error(`Production SQL error: ${JSON.stringify(errors)}`);
const result=body.results||[];
const rows=(index)=>result[index]?.response?.result?.rows||[];
const cols=(index)=>result[index]?.response?.result?.cols||[];
const values=(index)=>rows(index).map(row=>Object.fromEntries(cols(index).map((c,i)=>[c.name,row[i]?.value??null])));
const productionFields={sites:values(2).map(x=>x.name),site_pages:values(3).map(x=>x.name),site_search_fts:values(4).map(x=>x.name)};
const required={sites:['url','name','status'],site_pages:['site_id','url','title','description','content_hash','http_status','crawl_status']};
const missing=Object.fromEntries(Object.entries(required).map(([table,fields])=>[table,fields.filter(x=>!productionFields[table].includes(x))]));
console.log(JSON.stringify({ok:true,health:values(0),objects:values(1),productionFields,diagnosticPages:values(5),diagnosticFts:values(6),diagnosticSites:values(7),recentPages:values(8),pageForeignKeys:values(9),missing,writePerformed:false},null,2));
