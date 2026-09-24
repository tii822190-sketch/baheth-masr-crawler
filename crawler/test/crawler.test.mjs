import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/db.mjs';
import { extractHtml } from '../src/extract.mjs';
import { extractLightHtml } from '../src/light-extract.mjs';
import { classifyContent } from '../src/classify.mjs';
import { diagnoseReview, errorCode, isComplete, shouldUseBrowserFallback } from '../src/crawl.mjs';
import taxonomy from '../../taxonomy/search-taxonomy.json' with { type: 'json' };

test('canonicalize removes tracking and normalizes host', () => { assert.equal(canonicalize('https://WWW.Example.com/index.html?utm_source=x&a=1#x'), 'https://example.com/?a=1'); });
test('extracts original description separately from page-content summary', () => { const x=extractHtml('<title> Test </title><meta name="description" content="الوصف الأصلي"><main><h1>عنوان الصفحة</h1><p>نص مفيد للبحث.</p><p>جاري التحويل... اضغط هنا إذا لم يتم التحويل تلقائياً</p></main>','https://example.com/'); assert.equal(x.title,'Test'); assert.equal(x.description,'الوصف الأصلي'); assert.doesNotMatch(x.summary,/الوصف الأصلي|جاري التحويل/); assert.match(x.summary,/نص مفيد للبحث/); assert.match(x.searchSnippet,/الوصف الأصلي/); assert.ok(x.contentHash); });
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

test('hybrid fetching escalates a JavaScript shell with no rendered text to Chromium', () => {
  const result = { status: 200, contentType: 'text/html', body: `<html><head><title>مصر الرقمية</title><meta name="description" content="بوابة خدمات حكومية"><link rel="icon" href="/favicon.ico"></head><body><div id="__next"></div><script>${'window.app = true;'.repeat(20)}</script></body></html>` };
  const meta = extractHtml(result.body, 'https://digital.gov.eg/categories', result.contentType);
  assert.equal(meta.qualityStatus, 'dynamic_content');
  assert.equal(meta.extractedText.trim(), '');
  assert.equal(shouldUseBrowserFallback(result, meta), true);
  assert.equal(isComplete(result, { url: 'https://digital.gov.eg/categories', title: meta.title, description: meta.description, iconUrl: meta.iconUrl, keywords: 'حكومة', snippet: meta.searchSnippet, qualityStatus: meta.qualityStatus, extractedTextLength: meta.extractedText.length }), false);
});

test('hybrid fetching keeps usable server-rendered HTML on the HTTP path', () => {
  const body = `<html><head><title>خدمات وزارة حكومية</title><meta name="description" content="بوابة الخدمات الحكومية المتاحة إلكترونياً للمواطنين."><link rel="icon" href="/favicon.ico"></head><body><main><h1>الخدمات الحكومية</h1><p>${'يمكن للمواطن طلب الخدمات والاستعلام عنها إلكترونياً. '.repeat(10)}</p></main></body></html>`;
  const result = { status: 200, contentType: 'text/html', body };
  const extracted = extractHtml(body, 'https://example.gov.eg/', result.contentType);
  const meta = { url: 'https://example.gov.eg/', title: extracted.title, description: extracted.description, iconUrl: extracted.iconUrl, keywords: 'حكومة، خدمات', snippet: extracted.searchSnippet, qualityStatus: extracted.qualityStatus, extractedTextLength: extracted.extractedText.length };
  assert.equal(extracted.qualityStatus, 'good');
  assert.equal(shouldUseBrowserFallback(result, extracted), false);
  assert.equal(isComplete(result, meta), true);
});

test('review diagnostics retain actionable reason and missing required fields', () => {
  const result = { status: 200, contentType: 'text/html', method: 'http' };
  const diagnosis = diagnoseReview(result, { title: 'عنوان', qualityStatus: 'dynamic_content', extractedTextLength: 0 });
  assert.equal(diagnosis.reason, 'dynamic_content');
  assert.deepEqual(diagnosis.missingFields, ['url', 'description', 'iconUrl', 'keywords', 'snippet']);
  assert.equal(diagnosis.httpStatus, 200);
  assert.equal(diagnosis.fetchMethod, 'http');
  assert.equal(diagnoseReview({ status: 403, contentType: 'text/html', method: 'http' }, {}).reason, 'http_403');
});
