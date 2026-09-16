import taxonomy from '../../taxonomy/search-taxonomy.json' with { type: 'json' };

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[\u0617-\u061A\u064B-\u0652\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ةۀ]/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/[ئ]/g, 'ي')
    .replace(/[ؤ]/g, 'و')
    .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(text, keyword) {
  const term = normalize(keyword);
  if (!term || term.length < 2) return 0;
  return text.split(term).length - 1;
}

function scoreEntry(text, title, description, entry) {
  let score = 0;
  const reasons = [];
  for (const keyword of entry.keywords_ar || []) {
    const titleHits = countMatches(title, keyword);
    const descriptionHits = countMatches(description, keyword);
    const textHits = countMatches(text, keyword);
    const points = titleHits * 5 + descriptionHits * 3 + textHits;
    if (points) reasons.push({ keyword, titleHits, descriptionHits, textHits, points });
    score += points;
  }
  return { score, reasons };
}

export function classifyContent({ title = '', description = '', summary = '', extractedText = '' } = {}) {
  const normalizedTitle = normalize(title);
  const normalizedDescription = normalize(description);
  const normalizedText = normalize(`${summary} ${extractedText}`);
  const candidates = [];

  for (const category of taxonomy.categories) {
    const categoryScore = scoreEntry(`${normalizedTitle} ${normalizedDescription} ${normalizedText}`, normalizedTitle, normalizedDescription, category);
    const subcategories = category.subcategories
      .map((subcategory) => ({ ...subcategory, ...scoreEntry(`${normalizedTitle} ${normalizedDescription} ${normalizedText}`, normalizedTitle, normalizedDescription, subcategory) }))
      .filter((subcategory) => subcategory.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, taxonomy.classification_policy.max_subcategories);
    const score = categoryScore.score + subcategories.reduce((sum, item) => sum + item.score, 0);
    if (score > 0) candidates.push({
      category: category.id,
      score,
      reasons: categoryScore.reasons,
      subcategories: subcategories.map(({ id, score: subScore, reasons: subReasons }) => ({ id, score: subScore, reasons: subReasons })),
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  const best = candidates[0];
  const secondScore = candidates[1]?.score || 0;
  const confidence = best ? Number(Math.min(0.99, Math.max(0.05, (best.score - secondScore + Math.min(best.score, 10)) / 20)).toFixed(3)) : 0;
  return {
    categoryCandidate: best?.category || taxonomy.default_category,
    subcategoryCandidates: best?.subcategories.map((item) => item.id) || [],
    classificationScore: best?.score || 0,
    classificationConfidence: confidence,
    classificationStatus: 'candidate',
    classificationReasons: best?.reasons || [],
    classificationCandidates: candidates.slice(0, 5).map(({ category, score, subcategories }) => ({ category, score, subcategories: subcategories.map((item) => item.id) })),
  };
}

export { normalize as normalizeClassificationText };
