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
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const variants = new Set([escaped]);
  if (/^[\u0600-\u06FF\s]+$/.test(term)) {
    for (const prefix of ['ال', 'وال', 'بال', 'لل', 'فال', 'كال']) variants.add(`${prefix}${escaped}`);
  }
  let matches = 0;
  for (const variant of variants) {
    const matcher = new RegExp(`(^|[^\\p{L}\\p{N}])${variant}(?=$|[^\\p{L}\\p{N}])`, 'gu');
    matches += [...text.matchAll(matcher)].length;
  }
  return matches;
}

function scoreEntry(text, title, description, entry) {
  let score = 0;
  const reasons = [];
  for (const keyword of [...(entry.keywords_ar || []), ...(entry.keywords_en || [])]) {
    const titleHits = countMatches(title, keyword);
    const descriptionHits = countMatches(description, keyword);
    // Repeated boilerplate must not outweigh topic-specific title/description evidence.
    const textHits = Math.min(2, countMatches(text, keyword));
    const points = titleHits * 5 + descriptionHits * 3 + textHits;
    if (points) reasons.push({ keyword, titleHits, descriptionHits, textHits, points });
    score += points;
  }
  return { score, reasons };
}

export function classifyContent({ title = '', description = '', summary = '', extractedText = '', sourceUrl = '', metaKeywords = [] } = {}) {
  const normalizedTitle = normalize(title);
  const normalizedDescription = normalize(description);
  const normalizedText = normalize(`${summary} ${extractedText}`);
  const candidates = [];

  const sourceHint = normalize(sourceUrl);

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

  const quranSourceText = `${sourceHint} ${normalizedTitle} ${normalizedText}`;
  const isOfficialQuranDomain = /misrquran/.test(sourceHint);
  const isQuranSite = /quran com|quran ksu|mp3quran|misrquran|tanzil net|surahquran|quran navigator|holy quran|noble quran/.test(quranSourceText);
  const isQuranRadio = /holyquranradio|quranradio|اذاعة القرآن|راديو القرآن/.test(quranSourceText);
  if (isQuranSite || isQuranRadio) {
    const quran = candidates.find((candidate) => candidate.category === 'quran');
    const keyword = isQuranRadio ? 'quran_radio_source' : 'quran_site_source';
    const points = isOfficialQuranDomain ? 100 : (isQuranRadio ? 20 : 12);
    if (quran) {
      quran.score += points;
      quran.reasons.push({ keyword, titleHits: 0, descriptionHits: 0, textHits: 1, points });
    } else {
      candidates.push({ category: 'quran', score: points, reasons: [{ keyword, titleHits: 0, descriptionHits: 0, textHits: 1, points }], subcategories: [{ id: 'quran_audio', score: points, reasons: [] }] });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  const best = candidates[0];
  const secondScore = candidates[1]?.score || 0;
  const confidence = best ? Number(Math.min(0.99, Math.max(0.05, (best.score - secondScore + Math.min(best.score, 10)) / 20)).toFixed(3)) : 0;
  const matchedKeywords = best ? [
    ...best.reasons,
    ...best.subcategories.flatMap((item) => item.reasons || []),
  ].sort((a, b) => b.points - a.points || a.keyword.localeCompare(b.keyword))
    .map((item) => item.keyword)
    .filter((keyword, index, all) => all.indexOf(keyword) === index)
    .slice(0, 12) : [];
  const visibleEvidence = `${normalizedTitle} ${normalizedDescription} ${normalizedText}`;
  const metadataTerms = (Array.isArray(metaKeywords) ? metaKeywords : String(metaKeywords).split(/[,;|]/))
    .map((keyword) => String(keyword).trim())
    .filter((keyword) => normalize(keyword).length >= 3 && countMatches(visibleEvidence, keyword) > 0);
  for (const keyword of metadataTerms) {
    if (!matchedKeywords.some((existing) => normalize(existing) === normalize(keyword))) matchedKeywords.push(keyword);
    if (matchedKeywords.length >= 16) break;
  }
  return {
    categoryCandidate: best?.category || taxonomy.default_category,
    subcategoryCandidates: best?.subcategories.map((item) => item.id) || [],
    classificationScore: best?.score || 0,
    classificationConfidence: confidence,
    classificationStatus: 'candidate',
    classificationReasons: best?.reasons || [],
    matchedKeywords,
    classificationCandidates: candidates.slice(0, 5).map(({ category, score, subcategories }) => ({ category, score, subcategories: subcategories.map((item) => item.id) })),
  };
}

export { normalize as normalizeClassificationText };
