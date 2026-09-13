import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/db.mjs';
import { extractHtml } from '../src/extract.mjs';

test('canonicalize removes tracking and normalizes host', () => {
  assert.equal(canonicalize('https://WWW.Example.com/index.html?utm_source=x&a=1#x'), 'https://example.com/?a=1');
});

test('extracts safe metadata and same-page links', () => {
  const x=extractHtml('<html><head><title> Test </title><meta name="description" content="Desc"></head><body><a href="/about">About</a></body></html>','https://example.com/');
  assert.equal(x.title,'Test'); assert.equal(x.description,'Desc'); assert.equal(x.links[0],'https://example.com/about'); assert.ok(x.contentHash);
});
