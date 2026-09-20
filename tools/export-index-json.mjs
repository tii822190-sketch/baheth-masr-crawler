import fs from 'node:fs';
import Database from 'better-sqlite3';
import taxonomy from '../taxonomy/search-taxonomy.json' with { type: 'json' };

const input = process.argv[2] || process.env.CRAWLER_RESULTS_DB_PATH || '/tmp/crawler-results.sqlite';
const output = process.argv[3] || '/tmp/index-results.json';
const db = new Database(input, { readonly: true });
const run = db.prepare('SELECT MAX(source_run_id) AS id FROM crawl_results').get();
const rows = run?.id == null ? [] : db.prepare(`
  SELECT requested_url,title,description,icon_url,summary,category_candidate,
         subcategory_candidates_json,classification_reasons_json
  FROM crawl_results
  WHERE source_run_id=? AND crawl_status='success'
  ORDER BY id
`).all(run.id);
db.close();

const categoryById = new Map(taxonomy.categories.map((item) => [item.id, item]));
const subcategoryById = new Map();
for (const category of taxonomy.categories) {
  for (const subcategory of category.subcategories || []) subcategoryById.set(subcategory.id, subcategory);
}
const parse = (value) => { try { return JSON.parse(value || '[]'); } catch { return []; } };
const unique = (values) => [...new Set(values.filter(Boolean))];

const result = rows.map((row) => {
  const category = categoryById.get(row.category_candidate);
  const subcategoryIds = parse(row.subcategory_candidates_json);
  const reasons = parse(row.classification_reasons_json);
  const reasonKeywords = reasons.map((item) => item.keyword).filter((value) => value && !String(value).endsWith('_source'));
  return {
    الرابط: row.requested_url || '',
    العنوان: row.title || '',
    الوصف: row.description || '',
    رابط_الأيقونة: row.icon_url || '',
    التصنيفات: unique([category?.name_ar, ...subcategoryIds.map((id) => subcategoryById.get(id)?.name_ar || id)]),
    الكلمات_المفتاحية: unique([...reasonKeywords, ...(category?.keywords_ar || [])]).slice(0, 10),
    الخلاصة: row.summary || ''
  };
});

fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Exported ${result.length} records to ${output}`);
