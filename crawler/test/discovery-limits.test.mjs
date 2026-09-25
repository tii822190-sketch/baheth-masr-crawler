import test from 'node:test';
import assert from 'node:assert/strict';
import { pageLimitForSite } from '../../tools/discovery-limits.mjs';

const limits = { defaultLimit: 50000, misrQuranLimit: 30000 };

test('uses the site-specific 30,000 limit for MisrQuran with or without www', () => {
  assert.equal(pageLimitForSite('https://misrquran.gov.eg/', limits), 30000);
  assert.equal(pageLimitForSite('https://www.misrquran.gov.eg/episodeDetails/1', limits), 30000);
});

test('keeps the 50,000 default for Quran.com and other sites', () => {
  assert.equal(pageLimitForSite('https://quran.com/ar', limits), 50000);
  assert.equal(pageLimitForSite('https://example.gov.eg/', limits), 50000);
});
