import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRobotsPolicyCache, fetchRobotsPolicy, isRobotsAllowed, parseRobotsTxt } from '../../tools/robots.mjs';

const ua = ['bahethmasrcrawler', 'bahethmasrdiscovery'];

test('robots parser selects the specific user-agent group and allows the more specific path rule', () => {
  const policy = parseRobotsTxt(`User-agent: *\nDisallow: /private\n\nUser-agent: BahethMasrCrawler\nDisallow: /private/reports\nAllow: /private/reports/public`, ua);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/private/page'), true);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/private/reports/public/secret'), true);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/public'), true);
});

test('robots parser merges repeated matching groups and allows an equal-length tie', () => {
  const policy = parseRobotsTxt(`User-agent: BahethMasrCrawler\nDisallow: /blocked\n\nUser-agent: BahethMasrCrawler\nAllow: /blocked`, ua);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/blocked'), true);
});

test('robots parser supports wildcard and end-anchor rules', () => {
  const policy = parseRobotsTxt(`User-agent: *\nDisallow: /tmp/*/private$\nDisallow: /secret`, ua);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/tmp/a/private'), false);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/tmp/a/private/more'), true);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/secret-zone'), false);
});

test('robots parser collects multiple sitemap records without terminating a group', () => {
  const policy = parseRobotsTxt(`User-agent: *\nDisallow: /private\nSitemap: https://example.com/map-a.xml\nSitemap: https://example.com/map-b.xml`);
  assert.deepEqual(policy.sitemaps, ['https://example.com/map-a.xml', 'https://example.com/map-b.xml']);
  assert.equal(isRobotsAllowed(policy, 'https://example.com/private'), false);
});

test('robots policy allows absent robots file and fails closed for network/server errors', async () => {
  const cache = new Map();
  const absent = await fetchRobotsPolicy('https://absent.example/', { cache, fetchImpl: async () => new Response('', { status: 404 }) });
  assert.equal(isRobotsAllowed(absent, 'https://absent.example/anything'), true);

  clearRobotsPolicyCache(cache);
  const unavailable = await fetchRobotsPolicy('https://busy.example/', { cache, fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(unavailable.denyAll, true);
  assert.equal(isRobotsAllowed(unavailable, 'https://busy.example/public'), false);

  clearRobotsPolicyCache(cache);
  const unreachable = await fetchRobotsPolicy('https://offline.example/', { cache, fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(isRobotsAllowed(unreachable, 'https://offline.example/public'), false);
});
