const blockedFile = /\.(?:7z|apk|avi|bin|css|csv|doc|docx|exe|gif|gz|ico|iso|jpe?g|js|json|m3u8|m4a|mp3|mp4|pdf|png|ppt|pptx|rar|rss|svg|tar|txt|webp|woff2?|xls|xlsx|xml|zip)(?:$|[?#])/i;
const blockedPath = /(?:^|\/)(?:admin|administrator|api|cart|checkout|comment|comments|feed|feeds|filter|login|logout|search|wp-admin|wp-json)(?:\/|$)/i;
const blockedPagePath = /(?:^|\/)(?:about(?:-us)?|contact(?:-us)?|privacy(?:-policy)?|terms(?:-of-service)?|من[-_ ]?نحن|اتصل[-_ ]?بنا|تواصل[-_ ]?معنا|سياسة[-_ ]?الخصوصية|الشروط[-_ ]?والأحكام)(?:\/|$)/i;
const trackingParameter = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|yclid|igshid|_ga|_gl|mc_cid|mc_eid|_hsenc|_hsmi|vero_id|oly_anon_id)$/i;

export function canonicalize(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/index\.(?:html?|php)$/i, '/') || '/';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    for (const key of [...url.searchParams.keys()]) if (trackingParameter.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return ''; }
}

function sameHost(a, b) {
  try {
    const left = new URL(a); const right = new URL(b);
    const leftPort = left.port || 'default'; const rightPort = right.port || 'default';
    return left.hostname.replace(/^www\./, '') === right.hostname.replace(/^www\./, '') && leftPort === rightPort;
  } catch { return false; }
}

export function pageUrlDecision(raw, siteUrl) {
  let rawParsed;
  let siteParsed;
  try { rawParsed = new URL(raw, siteUrl); siteParsed = new URL(siteUrl); } catch { return { url: '', reason: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(rawParsed.protocol)) return { url: '', reason: 'unsupported_scheme' };
  const url = canonicalize(rawParsed.toString());
  if (!url) return { url: '', reason: 'invalid_url' };
  if (rawParsed.hostname.replace(/^www\./, '') !== siteParsed.hostname.replace(/^www\./, '')) return { url: '', reason: 'external_host' };
  const rawPort = rawParsed.port || 'default';
  const sitePort = siteParsed.port || 'default';
  if (rawPort !== sitePort) return { url: '', reason: 'different_port' };
  const parsed = new URL(url);
  let path;
  try { path = decodeURIComponent(parsed.pathname).toLowerCase(); } catch { return { url: '', reason: 'invalid_path_encoding' }; }
  if (path === '/robots.txt') return { url: '', reason: 'robots_file' };
  if (blockedFile.test(path)) return { url: '', reason: 'asset_file' };
  if (blockedPath.test(path)) return { url: '', reason: 'administrative_or_feed_path' };
  if (blockedPagePath.test(path)) return { url: '', reason: 'noncontent_information_path' };
  if (/\/(?:sitemap(?:[-_].*)?|feed|rss|atom)(?:\.xml)?$/i.test(path)) return { url: '', reason: 'sitemap_or_feed_path' };
  if (/\/(?:search|find|query)(?:\/|$)/i.test(path)) return { url: '', reason: 'search_results_path' };
  return { url, reason: null };
}

export function isPageUrl(raw, siteUrl) {
  return pageUrlDecision(raw, siteUrl).url;
}

export function normalizeSitemapUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.searchParams.sort();
    return url.toString();
  } catch { return ''; }
}

export function sitemapUrl(raw, siteUrl, allowNonstandardPath = false) {
  const url = normalizeSitemapUrl(raw);
  if (!url || !sameHost(url, siteUrl)) return '';
  return allowNonstandardPath || /(?:sitemap|\.xml)(?:\.gz)?$/i.test(new URL(url).pathname.toLowerCase()) ? url : '';
}

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, token) => {
    const lower = token.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const codePoint = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(codePoint); } catch { return entity; }
  });
}

function tagPattern(name) {
  return `(?:[\\w.-]+:)?(?:${name})`;
}

export function xmlLinks(xml, baseUrl, siteUrl) {
  const text = String(xml || '').replace(/^\uFEFF/, '').trim();
  if (!text || /<\s*(?:!doctype\s+html|html\b)/i.test(text)) return { valid: false, pages: [], sitemaps: [] };
  const root = text.match(/<\s*([a-z][\w:.-]*)\b/i)?.[1]?.toLowerCase().split(':').at(-1) || '';
  if (!['urlset', 'sitemapindex', 'feed', 'rss', 'rdf'].includes(root)) {
    if (/^(?:\{|\[)/.test(text)) {
      try {
        const data = JSON.parse(text); const pages = []; const sitemaps = []; const rejected = {};
        const add = (value, kind = 'page') => {
          if (typeof value !== 'string' || !value.trim()) return;
          try {
            const absolute = new URL(value.trim(), baseUrl).toString();
            if (kind === 'sitemap') {
              const nested = sitemapUrl(absolute, new URL(baseUrl).origin, true);
              if (nested && !sitemaps.includes(nested)) sitemaps.push(nested);
              return;
            }
            const nested = sitemapUrl(absolute, siteUrl);
            if (nested && !sitemaps.includes(nested)) { sitemaps.push(nested); return; }
            const decision = pageUrlDecision(absolute, siteUrl);
            if (decision.url && !pages.includes(decision.url)) pages.push(decision.url);
            else if (!decision.url) rejected[decision.reason] = (rejected[decision.reason] || 0) + 1;
          } catch {}
        };
        const visit = (value, kind = 'page') => {
          if (Array.isArray(value)) { for (const item of value) visit(item, kind); return; }
          if (typeof value === 'string') { add(value, kind); return; }
          if (!value || typeof value !== 'object') return;
          const keys = Object.keys(value);
          for (const key of keys) {
            const child = value[key];
            if (/^(?:sitemaps?|sitemapindex|sitemap_index|children)$/i.test(key)) visit(child, 'sitemap');
            else if (/^(?:urlset|urls|pages|items|entries)$/i.test(key)) visit(child, 'page');
            else if (/^(?:loc|url|href|external_url|link)$/i.test(key)) {
              if (typeof child === 'string') add(child, kind);
              else if (child && typeof child === 'object') visit(child, kind);
            } else if (child && typeof child === 'object') visit(child, kind);
          }
        };
        visit(data);
        if (pages.length || sitemaps.length) return { valid: true, pages, sitemaps, rejected, format: 'json' };
      } catch {}
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.some((line) => !/^https?:\/\//i.test(line))) return { valid: false, pages: [], sitemaps: [], rejected: {} };
    const pages = []; const rejected = {};
    for (const line of lines) {
      const decision = pageUrlDecision(line, siteUrl);
      if (decision.url && !pages.includes(decision.url)) pages.push(decision.url);
      else if (!decision.url) rejected[decision.reason] = (rejected[decision.reason] || 0) + 1;
    }
    return { valid: true, pages, sitemaps: [], rejected, format: 'url-list' };
  }

  const pages = [];
  const sitemaps = [];
  const rejected = {};
  const add = (raw) => {
    try {
      const url = new URL(decodeXml(raw).trim(), baseUrl).toString();
      const nested = sitemapUrl(url, siteUrl);
      if (nested && !sitemaps.includes(nested)) sitemaps.push(nested);
      else {
        const decision = pageUrlDecision(url, siteUrl);
        if (decision.url && !pages.includes(decision.url)) pages.push(decision.url);
        else if (!decision.url) rejected[decision.reason] = (rejected[decision.reason] || 0) + 1;
      }
    } catch {}
  };

  const locExpression = new RegExp(`<\\s*${tagPattern('loc')}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${tagPattern('loc')}\\s*>`, 'gi');
  if (root === 'sitemapindex') {
    const sitemapExpression = new RegExp(`<\\s*${tagPattern('sitemap')}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${tagPattern('sitemap')}\\s*>`, 'gi');
    for (const sitemapMatch of text.matchAll(sitemapExpression)) {
      for (const locMatch of sitemapMatch[1].matchAll(locExpression)) {
        try {
          const nested = sitemapUrl(new URL(decodeXml(locMatch[1]).trim(), baseUrl).toString(), baseUrl, true);
          if (nested && !sitemaps.includes(nested)) sitemaps.push(nested);
        } catch {}
      }
    }
  } else {
    for (const match of text.matchAll(locExpression)) add(match[1]);
  }

  if (['feed', 'rss', 'rdf'].includes(root)) {
    const entryExpression = new RegExp(`<\\s*${tagPattern('entry|item')}\\b[\\s\\S]*?<\\s*\\/\\s*${tagPattern('entry|item')}\\s*>`, 'gi');
    for (const entry of text.matchAll(entryExpression)) {
      const hrefExpression = new RegExp(`<\\s*${tagPattern('link')}\\b[^>]*\\bhref\\s*=\\s*["']([^"']+)["']`, 'gi');
      const textLinkExpression = new RegExp(`<\\s*${tagPattern('link')}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${tagPattern('link')}\\s*>`, 'gi');
      for (const match of entry[0].matchAll(hrefExpression)) add(match[1]);
      for (const match of entry[0].matchAll(textLinkExpression)) add(match[1]);
    }
  }

  return { valid: true, pages, sitemaps, rejected, format: root };
}

export function htmlSitemapLinks(html, baseUrl, siteUrl) {
  const $ = cheerio.load(String(html || ''));
  const pages = []; const rejected = {};
  $('a[href]').each((_, element) => {
    let absolute;
    try { absolute = new URL($(element).attr('href'), baseUrl).toString(); } catch { return; }
    const decision = pageUrlDecision(absolute, siteUrl);
    if (decision.url && !pages.includes(decision.url)) pages.push(decision.url);
    else if (!decision.url) rejected[decision.reason] = (rejected[decision.reason] || 0) + 1;
  });
  return { pages, rejected, linksFound: $('a[href]').length };
}

export function declaredSitemapLinks(html, baseUrl, siteUrl) {
  const $ = cheerio.load(String(html || ''));
  const sitemaps = new Set();
  const consider = (raw) => {
    try {
      const url = new URL(raw, baseUrl).toString();
            const normalized = sitemapUrl(url, new URL(baseUrl).origin, true);
      if (normalized) sitemaps.add(normalized);
    } catch {}
  };
  $('link[rel][href]').each((_, element) => {
    const rel = String($(element).attr('rel') || '').toLowerCase().split(/\s+/);
    const type = String($(element).attr('type') || '').toLowerCase();
    if (rel.includes('sitemap') || (rel.includes('alternate') && /(?:xml|rss|atom)/.test(type) && /sitemap/i.test($(element).attr('title') || ''))) consider($(element).attr('href'));
  });
  $('a[href]').each((_, element) => {
    const label = `${$(element).text()} ${$(element).attr('title') || ''} ${$(element).attr('aria-label') || ''}`;
    if (/(?:sitemap|site\s*map|خريطة\s*(?:الموقع|المواقع)|خرائط\s*الموقع)/i.test(label)) consider($(element).attr('href'));
  });
  return [...sitemaps];
}

export function shouldHydratePage(html, { minimumLinks = 12, minimumTextLength = 700 } = {}) {
  const source = String(html || '');
  const $ = cheerio.load(source);
  const links = $('a[href]').length;
  const textLength = $('body').text().replace(/\s+/g, ' ').trim().length;
  const appShell = /(?:__next|__nuxt|ng-version|data-reactroot|id=["'](?:app|root|__next|__nuxt)["']|webpack|chunk-vendors|enable javascript|فعّل جافاسكربت)/i.test(source);
  return appShell || links < minimumLinks || textLength < minimumTextLength;
}
import * as cheerio from 'cheerio';
