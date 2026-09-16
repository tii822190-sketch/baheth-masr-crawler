import Database from 'better-sqlite3';

const rawUrl=process.env.TURSO_CRAWLER_DATABASE_URL, token=process.env.TURSO_CRAWLER_AUTH_TOKEN;
if(!rawUrl||!token)throw new Error('TURSO_CRAWLER_DATABASE_URL and TURSO_CRAWLER_AUTH_TOKEN are required');
const baseUrl=rawUrl.replace(/^libsql:\/\//,'https://').replace(/^turso:\/\//,'https://').replace(/\/$/,'');
const links=new Database(process.env.CRAWLER_INPUT_DB_PATH||'db/links.sqlite',{readonly:true});
const results=new Database(process.env.CRAWLER_RESULTS_DB_PATH||'db/results.sqlite',{readonly:true});
const encode=value=>value===null?{type:'null'}:typeof value==='number'?(Number.isInteger(value)?{type:'integer',value:String(value)}:{type:'float',value:value}):{type:'text',value:String(value)};
async function send(statements){for(let i=0;i<statements.length;i+=40){const batch=statements.slice(i,i+40);const response=await fetch(`${baseUrl}/v2/pipeline`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests:[...batch,{type:'close'}]})});const body=await response.json();if(!response.ok)throw new Error(`Turso HTTP ${response.status}: ${JSON.stringify(body)}`);const errors=(body.results||[]).filter(x=>x.type==='error'||x.response?.error);if(errors.length)throw new Error(`Turso SQL error: ${JSON.stringify(errors.slice(0,2))}`);}}
function tableStatements(database,table){const columns=database.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);const rows=database.prepare(`SELECT * FROM ${table}`).all();const sql=`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`;return rows.map(row=>({type:'execute',stmt:{sql,args:columns.map(c=>encode(row[c]))}}));}
const groups=[['links',links,['sites','site_pages','crawl_runs','crawl_targets','crawl_observations','crawl_discoveries']],['results',results,['crawl_results','crawl_review_items','crawl_quarantine']]];
const reset=['crawl_quarantine','crawl_review_items','crawl_results','crawl_discoveries','crawl_observations','crawl_targets','site_pages','crawl_runs','sites'].map(table=>({type:'execute',stmt:{sql:`DELETE FROM ${table}`}}));await send(reset);let total=0;for(const [,database,tables] of groups)for(const table of tables){const statements=tableStatements(database,table);await send(statements);total+=statements.length;console.log(`${table}: ${statements.length}`);}
console.log(JSON.stringify({ok:true,statements:total},null,2));links.close();results.close();
