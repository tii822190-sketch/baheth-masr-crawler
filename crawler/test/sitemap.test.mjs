import test from 'node:test';
import assert from 'node:assert/strict';
import { sitemapCandidates, feedCandidates } from '../../tools/sitemap-candidates.mjs';
import { canonicalize, declaredSitemapLinks, htmlArabicAlternateLinks, htmlSitemapLinks, isPageUrl, normalizeSitemapUrl, shouldHydratePage, sitemapUrl, xmlLinks } from '../../tools/sitemap-parser.mjs';

const site = 'https://www.example.com/';

test('sitemap candidates cover common CMS paths, index variants, and gzip forms', () => {
  const candidates = sitemapCandidates(site);
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.xml.gz', '/sitemap.html', '/sitemap.txt', '/sitemap.json', '/wp-sitemap.xml', '/wp-sitemap-index.xml', '/post-sitemap.xml', '/page-sitemap.xml', '/sitemaps/index.xml']) {
    assert.ok(candidates.includes(`https://www.example.com${path}`), `missing ${path}`);
  }
  assert.equal(new Set(candidates).size, candidates.length);
  assert.ok(feedCandidates(site).includes('https://www.example.com/index.atom'));
});

test('robots-listed sitemaps are recognized while external hosts are kept outside same-site crawling', () => {
  assert.equal(sitemapUrl('https://www.example.com/tenant/site-map.xml', site), 'https://example.com/tenant/site-map.xml');
  assert.equal(normalizeSitemapUrl('https://cdn.example.net/maps/archive?key=1'), 'https://cdn.example.net/maps/archive?key=1');
  assert.equal(sitemapUrl('https://cdn.example.net/sitemap.xml', site), '');
});

test('XML sitemap index follows nested maps and deduplicates canonical page URLs', () => {
  const xml = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://www.example.com/sitemap-posts.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap><sitemap><loc>https://example.com/maps/archive</loc></sitemap></sitemapindex>`;
  const result = xmlLinks(xml, 'https://example.com/sitemap-index.xml', site);
  assert.equal(result.valid, true);
  assert.deepEqual(result.sitemaps, ['https://example.com/sitemap-posts.xml', 'https://example.com/maps/archive']);
});

test('an explicitly declared external sitemap index may follow same-host children but not external page URLs', () => {
  const xml = `<sitemapindex><sitemap><loc>https://cdn.example.net/maps/archive</loc></sitemap></sitemapindex>`;
  const result = xmlLinks(xml, 'https://cdn.example.net/sitemap-index', site);
  assert.deepEqual(result.sitemaps, ['https://cdn.example.net/maps/archive']);
  const externalPages = xmlLinks('<urlset><url><loc>https://cdn.example.net/article</loc></url></urlset>', 'https://cdn.example.net/maps/archive', site);
  assert.deepEqual(externalPages.pages, []);
});

test('namespaced sitemap XML and escaped locations are parsed while preserving distinct content parameters', () => {
  const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://example.com/a?x=1&amp;y=2</sm:loc></sm:url><sm:url><sm:loc>https://example.com/a?x=2</sm:loc></sm:url></sm:urlset>`;
  const result = xmlLinks(xml, 'https://example.com/sitemap.xml', site);
  assert.equal(result.valid, true);
  assert.deepEqual(result.pages, ['https://example.com/a?x=1&y=2', 'https://example.com/a?x=2']);
});

test('RSS and Atom entries yield page links including namespaced tags', () => {
  const rss = `<rss><channel><item><link>https://example.com/news/1</link></item></channel></rss>`;
  const atom = `<atom:feed><atom:entry><atom:link href="https://example.com/news/2" /></atom:entry></atom:feed>`;
  assert.deepEqual(xmlLinks(rss, site, site).pages, ['https://example.com/news/1']);
  assert.deepEqual(xmlLinks(atom, site, site).pages, ['https://example.com/news/2']);
});

test('JSON sitemap indexes, sitemap page lists, and JSON feeds expose URLs', () => {
  const index = xmlLinks('{"sitemaps":["https://example.com/maps/pages.json","https://example.com/maps/news.xml"]}', site, site);
  assert.deepEqual(index.sitemaps, ['https://example.com/maps/pages.json', 'https://example.com/maps/news.xml']);
  const list = xmlLinks('{"urlset":[{"loc":"https://example.com/report/1"},{"loc":"https://example.com/report/2"}]}', site, site);
  assert.deepEqual(list.pages, ['https://example.com/report/1', 'https://example.com/report/2']);
  const feed = xmlLinks('{"version":"https://jsonfeed.org/version/1.1","items":[{"url":"https://example.com/news/3"}]}', site, site);
  assert.deepEqual(feed.pages, ['https://example.com/news/3']);
});

test('page filter keeps only same-site, eligible page links', () => {
  assert.equal(canonicalize('https://WWW.Example.com/index.html?x=1#part'), 'https://example.com/?x=1');
  assert.equal(isPageUrl('https://other.example.net/page', site), '');
  assert.equal(isPageUrl('https://example.com:8443/articles/story', site), '');
  assert.equal(isPageUrl('https://example.com:8443/articles/story', 'https://example.com:8443/'), 'https://example.com:8443/articles/story');
  assert.equal(isPageUrl('https://example.com/report.pdf', site), '');
  assert.equal(isPageUrl('https://example.com/articles/story', site), 'https://example.com/articles/story');
  assert.equal(isPageUrl('https://example.com/category/news', site), 'https://example.com/category/news');
  assert.equal(isPageUrl('https://example.com/pages/education', site), 'https://example.com/pages/education');
  assert.equal(isPageUrl('https://example.com/page/12345', site), 'https://example.com/page/12345');
  assert.equal(isPageUrl('https://example.com/service?id=42', site), 'https://example.com/service?id=42');
  assert.equal(isPageUrl('https://example.com/service?id=42&utm_source=test', site), 'https://example.com/service?id=42');
  assert.equal(isPageUrl('https://example.com/service?id=43', site), 'https://example.com/service?id=43');
});

test('URL-list sitemaps preserve distinct query pages and ignore tracking-only variations', () => {
  const result = xmlLinks('https://example.com/service?id=41\nhttps://example.com/service?id=42&utm_source=newsletter', site, site);
  assert.equal(result.valid, true);
  assert.equal(result.format, 'url-list');
  assert.deepEqual(result.pages, ['https://example.com/service?id=41', 'https://example.com/service?id=42']);
});

test('HTML sitemaps and sitemap links advertised in the site are discoverable', () => {
  const html = '<!doctype html><html><body><a href="/ar/news">خريطة الموقع والأخبار</a><a href="/contact">Contact</a><a href="https://other.example.net/sitemap.xml">Sitemap</a></body></html>';
  assert.deepEqual(htmlSitemapLinks(html, site, site).pages, ['https://example.com/ar/news']);
  const advertised = '<link rel="sitemap" type="application/xml" href="/maps/current?version=4"><a href="/sitemap-page">خريطة الموقع</a>';
  assert.deepEqual(declaredSitemapLinks(advertised, site, site), ['https://example.com/maps/current?version=4', 'https://example.com/sitemap-page']);
});

test('sparse and JavaScript application-shell pages request browser rendering; complete static pages do not', () => {
  assert.equal(shouldHydratePage('<html><body><a href="/one">One</a></body></html>'), true);
  assert.equal(shouldHydratePage('<div id="app"><a href="/one">One</a>'.repeat(20) + '</div>'), true);
  const links = Array.from({ length: 16 }, (_, i) => `<a href="/section-${i}">Section ${i}</a>`).join('');
  const text = 'Government public information '.repeat(60);
  assert.equal(shouldHydratePage(`<html><body>${links}<main>${text}</main></body></html>`), false);
});

test('Quran.com pages are normalized to Arabic and non-Arabic language routes are excluded', () => {
  const quran = 'https://quran.com/';
  assert.equal(isPageUrl('https://quran.com/al-baqarah/1', quran), 'https://quran.com/ar/al-baqarah/1');
  assert.equal(isPageUrl('https://quran.com/ar/al-baqarah/1', quran), 'https://quran.com/ar/al-baqarah/1');
  assert.equal(isPageUrl('https://quran.com/en/al-baqarah/1', quran), '');
  assert.equal(isPageUrl('https://quran.com/al-baqarah/1?lang=en', quran), '');
  assert.equal(isPageUrl('https://quran.com/al-baqarah/1?locale=ar', quran), 'https://quran.com/ar/al-baqarah/1?locale=ar');
  assert.equal(isPageUrl('https://quran.com/al-baqarah/1/translations', quran), '');
  assert.equal(isPageUrl('https://quran.com/al-baqarah/1/tafsirs/en-tafsir-ibn-kathir', quran), '');
  assert.equal(isPageUrl('https://quran.com/what-is-ramadan/WhatIsRamadanSwahili', quran), '');
  assert.equal(isPageUrl('https://quran.com/al-baqarah/1/tafsirs/ar-tafsir-ibn-kathir', quran), 'https://quran.com/ar/al-baqarah/1/tafsirs/ar-tafsir-ibn-kathir');
  assert.equal(isPageUrl('https://misrquran.gov.eg/programmes', 'https://misrquran.gov.eg/'), 'https://misrquran.gov.eg/programmes');
  assert.equal(isPageUrl('https://misrquran.gov.eg/en/programmes', 'https://misrquran.gov.eg/'), '');
  assert.equal(isPageUrl('https://misrquran.gov.eg/programmes/english', 'https://misrquran.gov.eg/'), '');
});

test('Quran.com sitemap processing keeps only Arabic equivalents when languages are mixed', () => {
  const xml = `<urlset><url><loc>https://quran.com/al-baqarah/1</loc></url><url><loc>https://quran.com/en/al-baqarah/1</loc></url><url><loc>https://quran.com/ar/al-baqarah/2</loc></url><url><loc>https://quran.com/al-baqarah/1/translations</loc></url></urlset>`;
  const result = xmlLinks(xml, 'https://quran.com/sitemap.xml', 'https://quran.com/ar');
  assert.deepEqual(result.pages, ['https://quran.com/ar/al-baqarah/1', 'https://quran.com/ar/al-baqarah/2']);
});

test('XML sitemap alternate links prefer the same-site hreflang Arabic URL', () => {
  const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://example.gov/en/service</loc><xhtml:link rel="alternate" hreflang="en" href="https://example.gov/en/service"/><xhtml:link rel="alternate" hreflang="ar" href="https://example.gov/ar/service"/></url></urlset>`;
  const result = xmlLinks(xml, 'https://example.gov/sitemap.xml', 'https://example.gov/');
  assert.deepEqual(result.pages, ['https://example.gov/ar/service']);
});

test('HTML hreflang alternates add only the Arabic route on the same site', () => {
  const html = `<html><head><link rel="alternate" hreflang="en" href="/en/service"><link rel="alternate" hreflang="ar-EG" href="/ar/service"><link rel="alternate" hreflang="ar" href="https://other.example/service"></head></html>`;
  const result = htmlArabicAlternateLinks(html, 'https://example.gov/current', 'https://example.gov/');
  assert.deepEqual(result.pages, ['https://example.gov/ar/service']);
  assert.equal(result.rejected.external_host, 1);
});
