import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/db.mjs';
import { extractHtml } from '../src/extract.mjs';
import { extractLightHtml } from '../src/light-extract.mjs';
import { classifyContent } from '../src/classify.mjs';
import { errorCode } from '../src/crawl.mjs';
import { validateRow } from '../../tools/validate-staging.mjs';
import taxonomy from '../../taxonomy/search-taxonomy.json' with { type: 'json' };

test('canonicalize removes tracking and normalizes host', () => { assert.equal(canonicalize('https://WWW.Example.com/index.html?utm_source=x&a=1#x'), 'https://example.com/?a=1'); });
test('extracts original description separately from page-content summary', () => { const x=extractHtml('<title> Test </title><meta name="description" content="الوصف الأصلي"><main><h1>عنوان الصفحة</h1><p>نص مفيد للبحث.</p></main>','https://example.com/'); assert.equal(x.title,'Test'); assert.equal(x.description,'الوصف الأصلي'); assert.match(x.summary,/عنوان الصفحة/); assert.match(x.summary,/نص مفيد للبحث/); assert.doesNotMatch(x.summary,/الوصف الأصلي/); assert.match(x.searchSnippet,/الوصف الأصلي/); assert.ok(x.contentHash); });
test('classifies Quran content as a reviewable candidate', () => { const x=classifyContent({title:'تفسير القرآن الكريم',description:'قراءة القرآن وتفسير الآيات والاستماع إلى التلاوات',summary:'مصحف إلكتروني',extractedText:'تفسير سورة البقرة ومعاني الآيات'}); assert.equal(x.categoryCandidate,'quran'); assert.equal(x.classificationStatus,'candidate'); assert.ok(x.subcategoryCandidates.includes('quran_tafsir')); assert.ok(x.classificationConfidence>0); });
test('classifies health content without auto-approving it', () => { const x=extractHtml('<title>عيادة أسنان في القاهرة</title><meta name="description" content="طبيب أسنان وعيادة متخصصة"><main><p>'+('خدمات طبية وفحص أسنان '.repeat(30))+'</p></main>','https://example.com/'); assert.equal(x.categoryCandidate,'health'); assert.equal(x.classificationStatus,'candidate'); assert.ok(x.subcategoryCandidates.includes('clinic')); });
test('extracts safe metadata and same-page links', () => { const x=extractHtml('<html><head><title> Test </title><meta name="description" content="Desc"></head><body><a href="/about">About</a></body></html>','https://example.com/'); assert.equal(x.links[0].url,'https://example.com/about'); assert.equal(x.links[0].type,'internal'); });
test('removes CSS and JavaScript and keeps useful structured content', () => { const x=extractHtml('<style>.bad{color:red}</style><script>window.secret="bad"</script><body><nav>Menu</nav><main><h1>عنوان مفيد</h1><p>هذا نص مفيد للبحث.</p></main><footer>حقوق النشر</footer></body>','https://example.com/'); assert.match(x.extractedText,/عنوان مفيد/); assert.doesNotMatch(x.extractedText,/color:red|window\.secret|حقوق النشر|Menu/); });
test('cleans quoted embedded social URLs and classifies them', () => { const x=extractHtml('<a href="&quot;https://facebook.com/page">Facebook</a>','https://example.com/'); assert.equal(x.links[0].url,'https://facebook.com/page'); assert.equal(x.links[0].type,'social'); assert.deepEqual(x.socialLinks,['https://facebook.com/page']); });
test('uses article content instead of a generic Blogger description', () => { const x=extractHtml('<title>مقالة تقنية</title><meta name="description" content="وصف عام للمدونة يتكرر في كل الصفحات"><article><h1>مقالة تقنية</h1><p>هذه فقرة خاصة بالمقالة تشرح طريقة بناء أداة مفيدة للمطورين.</p><p>وتحتوي على تفاصيل مختلفة عن بقية صفحات الموقع.</p></article>','https://codenex1.blogspot.com/2026/03/article.html'); assert.match(x.description,/هذه فقرة خاصة بالمقالة/); assert.doesNotMatch(x.description,/وصف عام للمدونة/); });
test('keeps comment feeds out of discovered links', () => { const x=extractHtml('<article><p>'+('محتوى مفيد '.repeat(30))+'</p></article><a href="/feeds/123/comments/default">comments</a><a href="/2026/03/post.html">post</a>','https://codenex1.blogspot.com/'); assert.deepEqual(x.internalLinks,['https://codenex1.blogspot.com/2026/03/post.html']); });
test('marks Blogger traffic challenges instead of indexing them as content', () => { const x=extractHtml('<title>موقع codenex1.blogspot.com</title><main><p>Our systems have detected unusual traffic from your computer network. This page checks to see if it is really you and not a robot.</p></main>','https://codenex1.blogspot.com/2026/03/challenge.html'); assert.equal(x.qualityStatus,'blocked_challenge'); assert.equal(x.isChallenge,true); });
test('light extraction keeps only index fields with a 250-character description limit', () => { const x=extractLightHtml('<title>عنوان</title><meta name="description" content="وصف مختصر"><link rel="icon" href="/favicon.ico"><main><p>'+('محتوى مفيد للبحث '.repeat(80))+'</p><a href="/secret">رابط</a></main>','https://example.com/page'); assert.equal(x.iconUrl,'https://example.com/favicon.ico'); assert.match(x.summary,/محتوى مفيد للبحث/); assert.doesNotMatch(x.summary,/وصف مختصر/); assert.equal(x.searchSnippet,x.summary); assert.doesNotMatch(x.searchSnippet,/عنوان —/); assert.equal(x.links.length,0); assert.equal(x.internalLinks.length,0); assert.ok(x.description.length<=250); assert.ok(x.searchSnippet.length<=320); assert.ok(x.extractedText.length<=900); assert.ok(x.keywords.length<=3); assert.ok(x.categories.length<=3); });
test('light extraction falls back from empty HTML descriptions', () => { const x=extractLightHtml('<title>مكتبة القرآن الصوتية</title><meta name="description" content="&lt;p&gt;&lt;br&gt;&lt;/p&gt;"><main><p>تصفح واستماع وتحميل سور القرآن الكريم.</p></main>','https://mp3quran.net/'); assert.match(x.summary,/تصفح واستماع وتحميل سور القرآن الكريم/); assert.equal(x.searchSnippet,x.summary); assert.doesNotMatch(x.description,/<[a-z]/i); assert.match(x.description,/تصفح واستماع وتحميل سور القرآن الكريم/); });
test('classifies every taxonomy category without throwing', () => { for (const category of taxonomy.categories.filter((item) => item.id !== 'other')) { const keyword = category.keywords_ar?.[0] || category.name_ar; const result = classifyContent({ title: category.name_ar, description: `${keyword} ${category.name_en}`, summary: category.name_ar, extractedText: `${keyword} ${category.name_en}` }); assert.equal(result.categoryCandidate, category.id); assert.ok(result.classificationScore>0); } assert.equal(classifyContent({ title: '', description: '', summary: '', extractedText: '' }).categoryCandidate, 'other'); });
test('prioritizes the official Quran radio domain over secondary government words', () => { const result = classifyContent({ sourceUrl: 'https://misrquran.gov.eg/episodeDetails/1', title: 'سعي سيدنا علي للحاق بالرسول | إذاعة القرآن الكريم', description: 'تناولت الحلقة الهجرة وحفاوة أهل المدينة بالرسول', summary: 'إذاعة القرآن الكريم', extractedText: 'إذاعة القرآن الكريم' }); assert.equal(result.categoryCandidate, 'quran'); });
test('quarantine classifies HTTP error responses', () => {
  for (const [status, expected] of [[404, 'not_found'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'http_500']]) {
    assert.equal(errorCode({}, { httpStatus: status, contentType: 'text/html', meta: { qualityStatus: 'good' } }), expected);
  }
});
test('quarantine classifies timeout and fetch failures', () => {
  assert.equal(errorCode({ error: 'Error: browser_timeout' }, {}), 'timeout');
  assert.equal(errorCode({ error: 'Error: socket closed' }, {}), 'fetch_error');
});
test('quarantine rejects non-HTML and low-quality content', () => {
  assert.equal(errorCode({}, { httpStatus: 200, contentType: 'application/json', meta: { qualityStatus: 'not_indexable_api' } }), 'not_html');
  assert.equal(errorCode({}, { httpStatus: 200, contentType: 'text/html', meta: { qualityStatus: 'dynamic_content' } }), 'dynamic_content');
  assert.equal(errorCode({}, { httpStatus: 200, contentType: 'text/html', meta: { qualityStatus: 'thin_content' } }), 'thin_content');
});
test('validation approves a complete good HTML result with clear classification', () => {
  const row={crawl_status:'success',http_status:200,content_type:'text/html',quality_status:'good',title:'عنوان',extracted_text:'x'.repeat(400),search_text:'x'.repeat(120),canonical_url:'https://example.com/',category_candidate:'quran',classification_status:'candidate',classification_score:8,classification_confidence:0.8};
  assert.deepEqual(validateRow(row,1,1),{status:'approved',reason:'all_quality_and_classification_checks_passed'});
});
test('validation rejects failed, empty, or non-HTML results', () => {
  const row={crawl_status:'http_error',http_status:403,content_type:'application/json',quality_status:'not_indexable_api',title:'',extracted_text:'',search_text:'',canonical_url:'bad'};
  const result=validateRow(row,1);
  assert.equal(result.status,'rejected');
  assert.match(result.reason,/crawl_not_success/);
  assert.match(result.reason,/not_html/);
});
test('validation sends duplicate good canonical URLs to manual review', () => {
  const row={crawl_status:'success',http_status:200,content_type:'text/html',quality_status:'good',title:'عنوان',extracted_text:'x'.repeat(400),search_text:'x'.repeat(120),canonical_url:'https://example.com/',category_candidate:'quran',classification_status:'candidate',classification_score:8,classification_confidence:0.8};
  assert.equal(validateRow(row,2,1).status,'needs_review');
});
test('validation sends unclear classification to manual review', () => { const row={crawl_status:'success',http_status:200,content_type:'text/html',quality_status:'good',title:'عنوان',extracted_text:'x'.repeat(400),search_text:'x'.repeat(120),canonical_url:'https://example.com/',category_candidate:'other',classification_status:'candidate',classification_score:0,classification_confidence:0}; const result=validateRow(row,1,1); assert.equal(result.status,'needs_review'); assert.match(result.reason,/classification_unclear/); });
test('validation rejects duplicate content and invalid classification', () => { const row={crawl_status:'success',http_status:200,content_type:'text/html',quality_status:'good',title:'عنوان',extracted_text:'x'.repeat(400),search_text:'x'.repeat(120),canonical_url:'https://example.com/',category_candidate:'invalid',classification_status:'candidate',classification_score:8,classification_confidence:0.8}; const result=validateRow(row,1,2); assert.equal(result.status,'rejected'); assert.match(result.reason,/duplicate_content_hash/); assert.match(result.reason,/invalid_category_candidate/); });
