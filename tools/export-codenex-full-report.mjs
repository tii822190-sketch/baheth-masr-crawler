import fs from 'node:fs';
import Database from 'better-sqlite3';

const results = new Database('db/results.sqlite', { readonly: true });
const links = new Database('db/links.sqlite', { readonly: true });
const result = results.prepare('SELECT * FROM crawl_results ORDER BY id DESC LIMIT 1').get();
const discoveries = links.prepare('SELECT * FROM crawl_discoveries ORDER BY id').all();
const targets = links.prepare('SELECT * FROM crawl_targets ORDER BY id').all();
const report = {
  generatedAt: new Date().toISOString(),
  source: 'https://codenex1.blogspot.com',
  result,
  targets,
  discoveries,
  extractedText: result?.extracted_text || ''
};
fs.writeFileSync('artifacts/codenex-full-extraction.json', JSON.stringify(report, null, 2));
let md = `# التقرير الكامل لاختبار زاحف Codenex\n\n`;
md += `- الرابط المطلوب: ${result.requested_url}\n- الرابط النهائي: ${result.response_url}\n- الحالة: ${result.crawl_status}\n- HTTP: ${result.http_status}\n- زمن الاستجابة: ${result.duration_ms} ms\n- نوع المحتوى: ${result.content_type}\n- حجم الاستجابة: ${result.content_length} bytes\n- العنوان: ${result.title}\n- الوصف: ${result.description}\n- الأيقونة: ${result.icon_url || '(غير موجودة)'}\n- بصمة المحتوى: ${result.content_hash}\n- عدد الروابط المستخرجة: ${result.discovered_links_count}\n\n## النص المستخرج بالكامل\n\n${result.extracted_text}\n\n## أهداف الزحف\n\n| النوع | الرابط | السبب | الحالة |\n|---|---|---|---|\n`;
for (const x of targets) md += `| ${x.target_type} | ${x.url} | ${x.reason} | ${x.status} |\n`;
md += `\n## الروابط المكتشفة\n\n| # | الرابط | الرابط القياسي | المصدر | الحالة | من صفحة |\n|---:|---|---|---|---|---|\n`;
for (const [i, x] of discoveries.entries()) md += `| ${i + 1} | ${x.discovered_url} | ${x.canonical_url} | ${x.discovery_source} | ${x.status} | ${x.discovered_from_url} |\n`;
fs.writeFileSync('artifacts/codenex-full-extraction.md', md);
console.log(JSON.stringify({ json: 'artifacts/codenex-full-extraction.json', markdown: 'artifacts/codenex-full-extraction.md', textCharacters: result.extracted_text.length, discoveries: discoveries.length }, null, 2));
results.close(); links.close();
