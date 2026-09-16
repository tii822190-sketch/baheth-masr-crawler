import Database from 'better-sqlite3';
const rawUrl=process.env.TURSO_CRAWLER_DATABASE_URL, token=process.env.TURSO_CRAWLER_AUTH_TOKEN;
if(!rawUrl||!token)throw new Error('TURSO_CRAWLER_DATABASE_URL and TURSO_CRAWLER_AUTH_TOKEN are required');
const baseUrl=rawUrl.replace(/^libsql:\/\//,'https://').replace(/^turso:\/\//,'https://').replace(/\/$/,'');
const links=new Database(process.env.CRAWLER_INPUT_DB_PATH||'db/links.sqlite');
const results=new Database(process.env.CRAWLER_RESULTS_DB_PATH||'db/results.sqlite');
const encode=v=>v===null?{type:'null'}:typeof v==='number'?(Number.isInteger(v)?{type:'integer',value:String(v)}:{type:'float',value:v}):{type:'text',value:String(v)};
async function query(sql,args=[]){const r=await fetch(`${baseUrl}/v2/pipeline`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql,args}}, {type:'close'}]})});const b=await r.json();if(!r.ok)throw Error(`Turso HTTP ${r.status}: ${JSON.stringify(b)}`);const e=(b.results||[]).filter(x=>x.type==='error'||x.response?.error);if(e.length)throw Error(`Turso SQL error: ${JSON.stringify(e.slice(0,2))}`);return b.results?.[0]?.response?.result||{cols:[],rows:[]};}
const value=x=>x?.value??null;
async function restore(database,tables){for(const table of tables){const info=database.prepare(`PRAGMA table_info(${table})`).all();const columns=info.map(x=>x.name);const placeholders=columns.map(()=>'?').join(',');let offset=0,total=0;while(true){const result=await query(`SELECT * FROM ${table} ORDER BY rowid LIMIT 500 OFFSET ?`,[encode(offset)]);if(!result.rows.length)break;const rows=result.rows.map(row=>Object.fromEntries(row.map((v,i)=>[result.cols[i].name,value(v)])));const insert=database.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`);const tx=database.transaction(batch=>{for(const row of batch)insert.run(columns.map(c=>row[c]));});tx(rows);total+=rows.length;offset+=rows.length;if(rows.length<500)break;}console.log(`${table}: ${total}`);}}
await restore(links,['sites','site_pages','crawl_runs','crawl_targets','crawl_observations','crawl_discoveries','discovery_queue']);
await restore(results,['crawl_results','crawl_review_items','crawl_quarantine']);
links.close();results.close();
console.log(JSON.stringify({ok:true},null,2));
