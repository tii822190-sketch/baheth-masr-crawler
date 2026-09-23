const MAX_ROWS = 16;
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

function pageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

function rowFromInput(input) {
  const url = pageUrl(input.url || input.page_url || input.site_url || input.domain);
  const title = clean(input.title);
  const description = clean(input.description);
  const keywords = clean(input.keywords);
  const snippet = clean(input.snippet || input.content);
  const domain = siteDomain(url);
  const searchText = clean([title, description, keywords, snippet, domain].filter(Boolean).join(" "));
  if (!url || !searchText) return null;
  return { url, title, description, icon_url: clean(input.icon_url), search_text: searchText };
}

function upsertStatements(env, row) {
  return [env.DB.prepare(`
    INSERT INTO search_pages (url, title, description, icon_url, search_text)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title=excluded.title,
      description=excluded.description,
      icon_url=excluded.icon_url,
      search_text=excluded.search_text
  `).bind(row.url, row.title, row.description, row.icon_url, row.search_text),
    env.DB.prepare("DELETE FROM search_pages_fts WHERE url = ?").bind(row.url),
    env.DB.prepare("INSERT INTO search_pages_fts (url, search_text) VALUES (?, ?)").bind(row.url, row.search_text)];
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
      await env.DB.batch(rows.flatMap((row) => upsertStatements(env, row)));
      return json({ success: true, inserted: rows.length, rows: rows.map(({ url, search_text }) => ({ url, search_text })) });
    } catch (error) {
      console.error("ingest_error", error instanceof Error ? error.message : String(error));
      return json({ success: false, error: "Ingest failed" }, 500);
    }
  },
};
