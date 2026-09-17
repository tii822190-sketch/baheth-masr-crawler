const raw=process.env.TURSO_CRAWLER_DATABASE_URL,token=process.env.TURSO_CRAWLER_AUTH_TOKEN;
if(!raw||!token)throw Error('Crawler staging credentials required');
const endpoint=raw.replace(/^libsql:\/\//,'https://').replace(/^turso:\/\//,'https://').replace(/\/$/,'')+'/v2/pipeline';
const roots=['https://misrquran.gov.eg/','https://www.maspero.eg/','https://moe.gov.eg/','https://ellibrary.moe.gov.eg/','https://madrasetnaplus.eg/'];
const args=v=>({type:'text',value:v});
const requests=roots.map((url)=>({type:'execute',stmt:{sql:"INSERT OR IGNORE INTO sites (url,name,status,priority,discovery_status,last_discovered_at) VALUES (?,?,'active',50,'pending',NULL)",args:[args(url),args(new URL(url).hostname)]}}));
requests.push({type:'execute',stmt:{sql:"SELECT id,url,name,status,discovery_status,last_discovered_at FROM sites WHERE url IN (?,?,?,?,?,?,?,?,?,?) ORDER BY url",args:roots.flatMap((url)=>[args(url),args(url.replace('www.',''))])}});
requests.push({type:'close'});
const r=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests})});const b=await r.json();if(!r.ok||b.results?.some(x=>x.type==='error'||x.response?.error))throw Error(JSON.stringify(b));const d=b.results.at(-2).response.result;const rows=d.rows.map(row=>Object.fromEntries(d.cols.map((c,i)=>[c.name,row[i]?.value??null])));console.log(JSON.stringify({ok:true,added_or_existing:rows.length,sites:rows},null,2));
