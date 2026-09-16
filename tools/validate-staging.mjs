import Database from 'better-sqlite3';

const VALID_CATEGORIES = new Set([
  'quran', 'books', 'education', 'health', 'government', 'news', 'business', 'jobs',
  'technology', 'culture', 'sports', 'tourism', 'services', 'media', 'other',
]);
const VALID_CLASSIFICATION_STATUSES = new Set(['candidate', 'reviewed', 'approved', 'rejected']);

export function validateRow(row, duplicateCanonicalCount = 1, duplicateHashCount = 1) {
  const reasons = [];
  if (row.crawl_status !== 'success') reasons.push('crawl_not_success');
  if (!Number.isInteger(row.http_status) || row.http_status < 200 || row.http_status >= 400) reasons.push('http_not_success');
  if (!String(row.content_type || '').toLowerCase().includes('html')) reasons.push('not_html');
  if (row.quality_status !== 'good') reasons.push(`quality_${row.quality_status || 'unknown'}`);
  if (!row.title?.trim()) reasons.push('missing_title');
  if ((row.extracted_text || '').trim().length < 200) reasons.push('text_too_short');
  if ((row.search_text || '').trim().length < 100) reasons.push('search_text_too_short');
  if (!row.canonical_url || !/^https?:\/\//i.test(row.canonical_url)) reasons.push('invalid_canonical_url');
  if (duplicateCanonicalCount > 1) reasons.push('duplicate_canonical_url');
  if (duplicateHashCount > 1) reasons.push('duplicate_content_hash');

  const category = String(row.category_candidate || 'other');
  const classificationStatus = String(row.classification_status || 'candidate');
  const confidence = Number(row.classification_confidence || 0);
  const score = Number(row.classification_score || 0);
  if (!VALID_CATEGORIES.has(category)) reasons.push('invalid_category_candidate');
  if (!VALID_CLASSIFICATION_STATUSES.has(classificationStatus)) reasons.push('invalid_classification_status');
  if (classificationStatus === 'rejected') reasons.push('classification_rejected');
  if (category === 'other' || score <= 0) reasons.push('classification_unclear');
  else if (confidence < 0.45) reasons.push('classification_low_confidence');

  const blockingReasons = new Set([
    'crawl_not_success', 'http_not_success', 'not_html', 'quality_not_indexable_api', 'quality_dynamic_content',
    'quality_thin_content', 'quality_network_error', 'quality_unknown', 'missing_title', 'text_too_short',
    'search_text_too_short', 'invalid_canonical_url', 'invalid_category_candidate', 'invalid_classification_status',
    'classification_rejected',
  ]);
  const blocking = reasons.some((reason) => blockingReasons.has(reason));
  if (blocking) return { status: 'rejected', reason: reasons.join(',') };
  if (reasons.length === 0) return { status: 'approved', reason: 'all_quality_and_classification_checks_passed' };
  return { status: 'needs_review', reason: reasons.join(',') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new Database(process.env.CRAWLER_RESULTS_DB_PATH || 'db/results.sqlite');
  const validationRunId = Number(process.env.CRAWLER_SYNC_RUN_ID || 0);
  const runFilter = validationRunId > 0 ? ' WHERE r.source_run_id=?' : '';
  const rows = db.prepare(`
    SELECT v.*, r.crawl_status, r.http_status, r.content_type,
      r.quality_status AS result_quality_status, r.title AS result_title,
      r.extracted_text AS result_extracted_text, r.search_text AS result_search_text,
      r.canonical_url AS result_canonical_url, r.content_hash AS result_content_hash
    FROM crawl_review_items v JOIN crawl_results r ON r.id = v.result_id${runFilter} ORDER BY v.id
  `).all(...(validationRunId > 0 ? [validationRunId] : []));
  for (const row of rows) {
    row.quality_status = row.result_quality_status;
    row.title = row.result_title;
    row.extracted_text = row.result_extracted_text;
    row.search_text = row.result_search_text;
    row.canonical_url = row.result_canonical_url;
    row.content_hash = row.result_content_hash;
  }
  const canonicalCounts = new Map();
  const hashCounts = new Map();
  for (const row of rows) {
    canonicalCounts.set(row.canonical_url, (canonicalCounts.get(row.canonical_url) || 0) + 1);
    if (row.content_hash) hashCounts.set(row.content_hash, (hashCounts.get(row.content_hash) || 0) + 1);
  }
  const update = db.prepare('UPDATE crawl_review_items SET validation_status=?,validation_reason=?,validated_at=CURRENT_TIMESTAMP,validator_version=? WHERE id=?');
  const resultUpdate = db.prepare('UPDATE crawl_results SET distribution_status=? WHERE id=?');
  const tx = db.transaction(() => {
    let approved = 0; let rejected = 0; let needsReview = 0;
    for (const row of rows) {
      const validation = validateRow(row, canonicalCounts.get(row.canonical_url) || 1, hashCounts.get(row.content_hash) || 1);
      update.run(validation.status, validation.reason, 'v2-quality-classification', row.id);
      resultUpdate.run(validation.status === 'approved' ? 'approved' : validation.status === 'needs_review' ? 'needs_review' : 'rejected', row.result_id);
      if (validation.status === 'approved') approved += 1;
      else if (validation.status === 'needs_review') needsReview += 1;
      else rejected += 1;
    }
    return { total: rows.length, approved, rejected, needs_review: needsReview };
  });
  console.log(JSON.stringify(tx(), null, 2));
  db.close();
}
