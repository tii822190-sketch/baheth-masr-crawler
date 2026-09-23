const MAX_ROWS = 250;
const MAX_TEXT_LENGTH = 20000;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const expected = String(env.INGEST_TOKEN || "");
  if (!expected) return false;
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : request.headers.get("X-Ingest-Token") || "";
  return token.length > 0 && token === expected;
}

function siteDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      .toLowerCase()
      .replace(/^www\./, "");
  }
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

function rowFromInput(input) {
  const url = siteDomain(input.url || input.domain || input.site_url);
  const title = clean(input.title);
  const description = clean(input.description);
  const keywords = clean(input.keywords);
  const snippet = clean(input.snippet || input.content);
  const searchText = clean([title, description, keywords, url].filter(Boolean).join(" "));
  if (!url || !searchText) return null;
  return { url, title, description, icon_url: clean(input.icon_url), keywords, snippet, search_text: searchText };
}

async function upsert(env, row) {
  await env.DB.prepare(`
    INSERT INTO search_pages (url, title, description, icon_url, keywords, snippet, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title=excluded.title,
      description=excluded.description,
      icon_url=excluded.icon_url,
      keywords=excluded.keywords,
      snippet=excluded.snippet,
      search_text=excluded.search_text
  `).bind(row.url, row.title, row.description, row.icon_url, row.keywords, row.snippet, row.search_text).run();
  await env.DB.prepare("DELETE FROM search_pages_fts WHERE url = ?").bind(row.url).run();
  await env.DB.prepare("INSERT INTO search_pages_fts (url, search_text) VALUES (?, ?)").bind(row.url, row.search_text).run();
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ success: false, error: "POST required" }, 405);
    if (!authorized(request, env)) return json({ success: false, error: "Unauthorized" }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON" }, 400);
    }

    const inputs = Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [body];
    if (!inputs.length || inputs.length > MAX_ROWS) return json({ success: false, error: `Rows must be between 1 and ${MAX_ROWS}` }, 400);

    const rows = inputs.map(rowFromInput);
    if (rows.some((row) => !row)) return json({ success: false, error: "Each row needs a valid url and searchable fields" }, 400);

    try {
      for (const row of rows) await upsert(env, row);
      return json({ success: true, inserted: rows.length, rows: rows.map(({ url, search_text }) => ({ url, search_text })) });
    } catch (error) {
      console.error("ingest_error", error instanceof Error ? error.message : String(error));
      return json({ success: false, error: "Ingest failed" }, 500);
    }
  },
};
