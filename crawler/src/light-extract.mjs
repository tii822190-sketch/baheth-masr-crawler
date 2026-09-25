import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

const MAX_DESCRIPTION = 250;
const MAX_SNIPPET = 320;
const NON_CONTENT = 'script,style,noscript,template,svg,canvas,iframe,object,embed,form,button,input,select,textarea,nav,header,footer,aside,.sidebar,.navbar,.navigation,.social,.share,.comments,#comments,.cookie,.popup,.advert,.ads,.ad';

function clean(value = '', max = 0) {
  const text = String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return max > 0 ? text.slice(0, max).trim() : text;
}

function pageText($) {
  const root = $('article,main,.post-body,.entry-content,.post-content,body').first();
  if (!root.length) return '';
  const clone = root.clone();
  clone.find(NON_CONTENT).remove();
  const blocks = clone.find('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th').map((_, el) => clean($(el).text())).get().filter((text) => text.length >= 2);
  return clean(blocks.length ? blocks.join('\n') : clone.text());
}

function makeSummary(title, description, text) {
  let summary = clean(text)
    .replace(/جاري التحويل\.{2,}\s*اضغط هنا إذا لم يتم التحويل تلقائياً/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) summary = summary.split(title).join(' ').replace(/\s+/g, ' ').trim();
  return (summary || description || title || '').slice(0, MAX_SNIPPET).trim();
}

export function extractLightHtml(html, responseUrl, contentType = 'text/html') {
  let url = responseUrl;
  try { url = new URL(responseUrl).toString(); } catch {}
  const $ = cheerio.load(html || '');
  const title = clean($('title').first().text()) || clean($('meta[property="og:title" i]').attr('content') || '');
  const rawDescription = clean($('meta[name="description" i]').attr('content') || $('meta[property="og:description" i]').attr('content') || '');
  const description = rawDescription.slice(0, MAX_DESCRIPTION);
  const text = pageText($);
  const summary = makeSummary(title, description, text);
  const declaredIcon = $('link[rel~="icon" i]').attr('href') || '/favicon.ico';
  let iconUrl = '';
  try {
    const icon = new URL(declaredIcon, responseUrl);
    if (/^(?:\.\/)?favicon\.ico(?:[?#]|$)/i.test(declaredIcon.trim())) icon.pathname = '/favicon.ico';
    iconUrl = icon.toString();
  } catch {}
  const contentHash = crypto.createHash('sha256').update(`${url}\n${title}\n${description}\n${summary}\n${iconUrl}`).digest('hex');
  const good = Boolean(title && (description || summary) && iconUrl && summary);
  return {
    url,
    title,
    description: description || summary.slice(0, MAX_DESCRIPTION),
    summary,
    searchSnippet: summary,
    snippet: summary,
    iconUrl,
    extractedText: summary,
    contentHash,
    qualityStatus: good ? 'good' : 'thin_content',
    reviewStatus: good ? 'accepted' : 'review',
    keywords: '',
    categoryCandidate: 'other',
    subcategoryCandidates: [],
    categories: [],
    links: [],
    internalLinks: [],
    externalLinks: [],
    socialLinks: [],
    discoveredLinksCount: 0,
    contentType,
  };
}

export { MAX_DESCRIPTION, MAX_SNIPPET };
