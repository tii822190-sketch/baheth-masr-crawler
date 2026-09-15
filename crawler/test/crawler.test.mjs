import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/db.mjs';
import { extractHtml } from '../src/extract.mjs';

test('canonicalize removes tracking and normalizes host', () => {
  assert.equal(canonicalize('https://WWW.Example.com/index.html?utm_source=x&a=1#x'), 'https://example.com/?a=1');
});

test('extracts safe metadata and same-page links', () => {
  const x=extractHtml('<html><head><title> Test </title><meta name="description" content="Desc"></head><body><a href="/about">About</a></body></html>','https://example.com/');
  assert.equal(x.title,'Test'); assert.equal(x.description,'Desc'); assert.equal(x.links[0].url,'https://example.com/about'); assert.equal(x.links[0].type,'internal'); assert.ok(x.contentHash);
});

test('removes CSS and JavaScript and keeps useful structured content', () => {
  const html = `<html><head><style>.bad{color:red}</style><script>window.secret='bad'</script></head><body><nav>Menu</nav><main><h1>عنوان مفيد</h1><p>هذا نص مفيد للبحث.</p><ul><li>نقطة أولى</li></ul></main><footer>حقوق النشر</footer></body></html>`;
  const x = extractHtml(html, 'https://example.com/');
  assert.match(x.extractedText, /عنوان مفيد/); assert.match(x.extractedText, /هذا نص مفيد/); assert.doesNotMatch(x.extractedText, /color:red|window\.secret|حقوق النشر|Menu/);
});

test('cleans quoted embedded social URLs and classifies them', () => {
  const x = extractHtml('<a href="&quot;https://facebook.com/page">Facebook</a>', 'https://example.com/');
  assert.equal(x.links[0].url, 'https://facebook.com/page'); assert.equal(x.links[0].type,'social'); assert.deepEqual(x.socialLinks,['https://facebook.com/page']);
});
