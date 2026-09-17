const raw=process.env.TURSO_PRODUCTION_DATABASE_URL,token=process.env.TURSO_PRODUCTION_AUTH_TOKEN;
if(!raw||!token)throw Error('Production credentials required');
const endpoint=raw.replace(/^libsql:\/\//,'https://').replace(/^turso:\/\//,'https://').replace(/\/$/,'')+'/v2/pipeline';
const requests=[
 {type:'execute',stmt:{sql:'DROP TABLE IF EXISTS site_search_fts'}},
 {type:'execute',stmt:{sql:"CREATE VIRTUAL TABLE site_search_fts USING fts5(record_type UNINDEXED, record_id UNINDEXED, site_id UNINDEXED, priority UNINDEXED, title, description, content, keywords, categories, search_text)"}},
 {type:'execute',stmt:{sql:"INSERT INTO site_search_fts(record_type,record_id,site_id,priority,title,description,content,keywords,categories,search_text) SELECT 'page',printf('%d',id),site_id,priority,title,description,content,keywords,categories,search_text FROM site_pages WHERE status='active'"}},
 {type:'execute',stmt:{sql:'SELECT COUNT(*) AS pages FROM site_pages WHERE status=\'active\''}},
 {type:'execute',stmt:{sql:'SELECT COUNT(*) AS fts FROM site_search_fts'}},
 {type:'close'}
];
const r=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests})});const b=await r.json();if(!r.ok)throw Error(JSON.stringify(b));const e=(b.results||[]).filter(x=>x.type==='error'||x.response?.error);if(e.length)throw Error(JSON.stringify(e));const v=i=>b.results[i]?.response?.result?.rows?.[0]?.[0]?.value??null;console.log(JSON.stringify({ok:true,rebuild:true,production_pages:Number(v(3)),production_fts:Number(v(4)),equal:Number(v(3))===Number(v(4))},null,2));
