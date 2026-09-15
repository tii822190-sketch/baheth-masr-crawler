import Database from 'better-sqlite3';
const results = new Database('db/results.sqlite', { readonly: true });
const links = new Database('db/links.sqlite', { readonly: true });
const r = results.prepare('SELECT * FROM crawl_results ORDER BY id DESC LIMIT 1').get();
const d = links.prepare('SELECT discovered_url, discovery_source, status, title_hint, description_hint FROM crawl_discoveries ORDER BY id').all();
console.log(JSON.stringify({
  request: { url: r.requested_url, finalUrl: r.response_url, status: r.http_status, crawlStatus: r.crawl_status, durationMs: r.duration_ms },
  extracted: { title: r.title, description: r.description, iconUrl: r.icon_url, textCharacters: r.extracted_text.length, textPreview: r.extracted_text.slice(0, 600), contentHash: r.content_hash, contentLength: r.content_length },
  links: { total: d.length, internalOrSite: d.filter(x => x.discovered_url.includes('codenex1.blogspot.com')).length, samples: d.slice(0, 12) },
  fieldsPresent: { title: Boolean(r.title), description: Boolean(r.description), text: Boolean(r.extracted_text), hash: Boolean(r.content_hash), links: d.length > 0 }
}, null, 2));
results.close(); links.close();
