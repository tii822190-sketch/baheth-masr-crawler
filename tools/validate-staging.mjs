import Database from 'better-sqlite3';

export function validateRow(row, duplicateCount=1){
  const reasons=[];
  if(row.crawl_status!=='success')reasons.push('crawl_not_success');
  if(!Number.isInteger(row.http_status)||row.http_status<200||row.http_status>=400)reasons.push('http_not_success');
  if(!String(row.content_type||'').toLowerCase().includes('html'))reasons.push('not_html');
  if(row.quality_status!=='good')reasons.push(`quality_${row.quality_status||'unknown'}`);
  if(!row.title?.trim())reasons.push('missing_title');
  if((row.extracted_text||'').trim().length<300)reasons.push('text_too_short');
  if((row.search_text||'').trim().length<100)reasons.push('search_text_too_short');
  if(!row.canonical_url||!/^https?:\/\//i.test(row.canonical_url))reasons.push('invalid_canonical_url');
  if(duplicateCount>1)reasons.push('duplicate_canonical_url');
  if(reasons.length===0)return{status:'approved',reason:'all_quality_checks_passed'};
  const blocking=reasons.some(x=>!['duplicate_canonical_url'].includes(x));
  return{status:blocking?'rejected':'needs_review',reason:reasons.join(',')};
}

if (import.meta.url===`file://${process.argv[1]}`){
  const db=new Database(process.env.CRAWLER_RESULTS_DB_PATH||'db/results.sqlite');
  const rows=db.prepare('SELECT * FROM crawl_review_items ORDER BY id').all();
  const counts=new Map();
  for(const row of rows)counts.set(row.canonical_url,(counts.get(row.canonical_url)||0)+1);
  const update=db.prepare('UPDATE crawl_review_items SET validation_status=?,validation_reason=?,validated_at=CURRENT_TIMESTAMP,validator_version=? WHERE id=?');
  const resultUpdate=db.prepare("UPDATE crawl_results SET distribution_status=? WHERE id=?");
  const tx=db.transaction(()=>{let approved=0,rejected=0,needsReview=0;for(const row of rows){const v=validateRow(row,counts.get(row.canonical_url)||1);update.run(v.status,v.reason,'v1',row.id);resultUpdate.run(v.status==='approved'?'approved':v.status==='needs_review'?'needs_review':'rejected',row.result_id);if(v.status==='approved')approved++;else if(v.status==='needs_review')needsReview++;else rejected++;}return{total:rows.length,approved,rejected,needs_review:needsReview};});
  console.log(JSON.stringify(tx(),null,2));db.close();
}
