import crypto from 'node:crypto';
import { extractHtml } from './extract.mjs';
import taxonomy from '../../taxonomy/search-taxonomy.json' with { type: 'json' };

const MAX_DESCRIPTION = 250;
const MAX_SNIPPET = 320;
const MAX_LABELS = 3;

function clean(value = '', max = 0) {
  const text = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max).trim() : text;
}

function unique(values) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))];
}

function arabicLabels(categoryId, subcategoryIds) {
  const category = taxonomy.categories.find((item) => item.id === categoryId);
  const subcategories = (subcategoryIds || []).map((id) => category?.subcategories?.find((item) => item.id === id)?.name_ar || '').filter(Boolean);
  const keywords = unique([...(category?.keywords_ar || []), ...subcategories]);
  return { categoryLabel: category?.name_ar || 'أخرى', keywordLabels: keywords.slice(0, MAX_LABELS), labels: [category?.name_ar || 'أخرى', ...subcategories].slice(0, MAX_LABELS) };
}

export function extractLightHtml(html, responseUrl, contentType = 'text/html') {
  const full = extractHtml(html, responseUrl, contentType);
  const description = clean(clean(full.description) || clean(full.summary) || clean(full.searchSnippet), MAX_DESCRIPTION);
  const summary = clean(clean(full.summary) || clean(full.extractedText) || description, MAX_SNIPPET);
  const snippet = summary;
  const keywords = unique([
    ...(full.subcategoryCandidates || []),
    ...((full.classificationReasons || []).map((item) => item.keyword).filter((keyword) => !String(keyword).endsWith('_source'))),
  ]).slice(0, MAX_LABELS);
  const categories = unique([full.categoryCandidate, ...keywords]).slice(0, MAX_LABELS);
  const arabic = arabicLabels(full.categoryCandidate || 'other', full.subcategoryCandidates || []);
  const contentHash = crypto.createHash('sha256')
    .update(`${full.title}\n${description}\n${summary}\n${snippet}\n${full.iconUrl}\n${keywords.join('|')}\n${categories.join('|')}`)
    .digest('hex');

  return {
    ...full,
    description,
    summary,
    searchSnippet: snippet,
    searchText: clean(`${full.title} ${description} ${summary}`, 1800),
    extractedText: clean(snippet, 900),
    contentHash,
    categoryCandidate: full.categoryCandidate || 'other',
    subcategoryCandidates: arabic.keywordLabels,
    keywords: arabic.keywordLabels,
    categories: arabic.labels,
    categoryLabel: arabic.categoryLabel,
    links: [],
    internalLinks: [],
    externalLinks: [],
    socialLinks: [],
    discoveredLinksCount: 0,
  };
}

export { MAX_DESCRIPTION, MAX_SNIPPET, MAX_LABELS };
