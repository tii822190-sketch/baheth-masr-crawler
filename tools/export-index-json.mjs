import fs from 'node:fs';
import Database from 'better-sqlite3';
const input = process.argv[2] || process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite';
const output = process.argv[3] || '/tmp/index-results.json';
const db = new Database(input, { readonly: true });
const rows = db.prepare(`
  SELECT url,title,description,icon_url,keywords,snippet
  FROM index_results
  ORDER BY id
`).all();
db.close();
const result = rows.map((row) => ({
  الرابط: row.url,
  العنوان: row.title,
  الوصف: row.description,
  رابط_الأيقونة: row.icon_url,
  الكلمات_المفتاحية: row.keywords,
  الخلاصة: row.snippet,
}));
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Exported ${result.length} records to ${output}`);
