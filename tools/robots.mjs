const PRODUCT_TOKEN = 'bahethmasrcrawler';
const MAX_ROBOTS_BYTES = 512 * 1024;
const policyCache = new Map();

function normalizePath(value) {
  const encoded = encodeURI(String(value || '').trim()).replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());
  return encoded.replace(/%([0-9A-F]{2})/g, (part, hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : part;
  });
}

function makeRuleRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

export function parseRobotsTxt(text, productTokens = [PRODUCT_TOKEN]) {
  const groups = [];
  const sitemaps = [];
  let group = null;

  for (const rawLine of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (key === 'user-agent') {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      if (value) group.agents.push(value.toLowerCase());
      continue;
    }

    if (key === 'allow' || key === 'disallow') {
      if (group && value) group.rules.push({ allow: key === 'allow', pattern: normalizePath(value) });
    }
  }

  const products = productTokens.map((token) => String(token).toLowerCase()).filter(Boolean);
  const matched = [];
  for (const candidate of groups) {
    for (const agent of candidate.agents) {
      if (agent === '*') continue;
      if (products.some((product) => product === agent || product.startsWith(agent))) matched.push({ group: candidate, specificity: agent.length });
    }
  }

  let applicableGroups;
  if (matched.length) {
    applicableGroups = [...new Set(matched.map((item) => item.group))];
  } else {
    applicableGroups = groups.filter((candidate) => candidate.agents.includes('*'));
  }

  const rules = applicableGroups.flatMap((candidate) => candidate.rules);
  return { rules, sitemaps: [...new Set(sitemaps)] };
}

export function isRobotsAllowed(policy, rawUrl) {
  if (policy?.denyAll) return false;
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.pathname.toLowerCase() === '/robots.txt') return true;

  const path = normalizePath(`${url.pathname}${url.search}`);
  let best = null;
  for (const rule of policy?.rules || []) {
    const regex = makeRuleRegex(rule.pattern);
    if (!regex.test(path)) continue;
    const specificity = Buffer.byteLength(rule.pattern.replace(/[*$]/g, ''));
    if (!best || specificity > best.specificity || (specificity === best.specificity && rule.allow && !best.allow)) {
      best = { allow: rule.allow, specificity };
    }
  }
  return best ? best.allow : true;
}

async function readLimitedBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_ROBOTS_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, MAX_ROBOTS_BYTES - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < value.byteLength || size >= MAX_ROBOTS_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export function fetchRobotsPolicy(siteUrl, { timeoutMs = 10000, fetchImpl = fetch, cache = policyCache, productToken = PRODUCT_TOKEN } = {}) {
  let origin;
  try { origin = new URL(siteUrl).origin; } catch { return Promise.resolve({ denyAll: true, rules: [], sitemaps: [] }); }
  const cacheKey = `${origin}\n${String(productToken).toLowerCase()}`;
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, (async () => {
      try {
        const response = await fetchImpl(`${origin}/robots.txt`, {
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': `${productToken}/1.0` },
        });
        if (response.status === 429 || response.status >= 500) return { denyAll: true, rules: [], sitemaps: [] };
        if (response.status >= 400) return { denyAll: false, rules: [], sitemaps: [] };
        return { denyAll: false, ...parseRobotsTxt(await readLimitedBody(response), [productToken]) };
      } catch {
        return { denyAll: true, rules: [], sitemaps: [] };
      }
    })());
  }
  return cache.get(cacheKey);
}

export function clearRobotsPolicyCache(cache = policyCache) {
  cache.clear();
}

export { MAX_ROBOTS_BYTES };
