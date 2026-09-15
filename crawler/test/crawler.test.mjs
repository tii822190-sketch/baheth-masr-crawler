import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/db.mjs';
import { extractHtml } from '../src/extract.mjs';
import { errorCode } from '../src/crawl.mjs';

test('canonicalize removes tracking and normalizes host', () => { assert.equal(canonicalize('https://WWW.Example.com/index.html?utm_source=x&a=1#x'), 'https://example.com/?a=1'); });
test('extracts original metadata and generated search snippet separately', () => { const x=extractHtml('<title> Test </title><meta name="description" content="الوصف الأصلي"><main><h1>عنوان الصفحة</h1><p>نص مفيد للبحث.</p></main>','https://example.com/'); assert.equal(x.title,'Test'); assert.equal(x.description,'الوصف الأصلي'); assert.match(x.summary,/الوصف الأصلي/); assert.match(x.searchSnippet,/الوصف الأصلي/); assert.ok(x.contentHash); });
test('extracts safe metadata and same-page links', () => { const x=extractHtml('<html><head><title> Test </title><meta name="description" content="Desc"></head><body><a href="/about">About</a></body></html>','https://example.com/'); assert.equal(x.links[0].url,'https://example.com/about'); assert.equal(x.links[0].type,'internal'); });
test('removes CSS and JavaScript and keeps useful structured content', () => { const x=extractHtml('<style>.bad{color:red}</style><script>window.secret="bad"</script><body><nav>Menu</nav><main><h1>عنوان مفيد</h1><p>هذا نص مفيد للبحث.</p></main><footer>حقوق النشر</footer></body>','https://example.com/'); assert.match(x.extractedText,/عنوان مفيد/); assert.doesNotMatch(x.extractedText,/color:red|window\.secret|حقوق النشر|Menu/); });
test('cleans quoted embedded social URLs and classifies them', () => { const x=extractHtml('<a href="&quot;https://facebook.com/page">Facebook</a>','https://example.com/'); assert.equal(x.links[0].url,'https://facebook.com/page'); assert.equal(x.links[0].type,'social'); assert.deepEqual(x.socialLinks,['https://facebook.com/page']); });
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
