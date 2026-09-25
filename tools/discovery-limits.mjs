export function pageLimitForSite(siteUrl, { defaultLimit, misrQuranLimit }) {
  let hostname = '';
  try {
    hostname = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {}
  return hostname === 'misrquran.gov.eg' ? misrQuranLimit : defaultLimit;
}
