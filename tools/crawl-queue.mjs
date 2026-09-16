const rawUrl = process.env.TURSO_CRAWLER_DATABASE_URL;
const token = process.env.TURSO_CRAWLER_AUTH_TOKEN;
if (!rawUrl || !token) throw new Error('TURSO_CRAWLER_DATABASE_URL and TURSO_CRAWLER_AUTH_TOKEN are required');
const baseUrl = rawUrl.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '');
const arg = (type, value) => ({ type, value: String(value) });
function canonicalize(raw) {
  try {
    const u = new URL(raw.trim());
    u.hash = ''; u.username = ''; u.password = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    u.pathname = u.pathname.replace(/\/index\.(html?|php)$/i, '/') || '/';
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    [...u.searchParams.keys()].filter(k => /^(utm_|fbclid|gclid)/i.test(k)).forEach(k => u.searchParams.delete(k));
    return /^https?:$/.test(u.protocol) ? u.toString() : '';
  } catch { return ''; }
}
async function pipeline(statements) {
  const response = await fetch(`${baseUrl}/v2/pipeline`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [...statements.map(stmt => ({ type: 'execute', stmt })), { type: 'close' }] }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Turso HTTP ${response.status}: ${JSON.stringify(body)}`);
  const errors = (body.results || []).filter(x => x.type === 'error' || x.response?.error);
  if (errors.length) throw new Error(`Turso SQL error: ${JSON.stringify(errors.slice(0, 2))}`);
  return body.results || [];
}
function rows(result) {
  const r = result?.response?.result;
  const cols = (r?.cols || []).map(c => typeof c === 'string' ? c : c.name);
  return (r?.rows || []).map(row => Object.fromEntries(row.map((v, i) => [cols[i], v?.value ?? v])));
}
const [command, ...values] = process.argv.slice(2);
if (!['add', 'list', 'claim', 'done', 'fail', 'reset'].includes(command)) throw new Error('Usage: add <url...> | list | claim | done <id> | fail <id> <message> | reset <id>');
if (command === 'add') {
  const urls = values.flatMap(value => value.split(',')).map(canonicalize).filter(Boolean);
  if (!urls.length) throw new Error('No valid URLs supplied');
  const results = await pipeline(urls.map(url => ({ sql: `INSERT OR IGNORE INTO crawl_site_queue(url,canonical_url) VALUES(?,?)`, args: [arg('text', url), arg('text', url)] })));
  console.log(JSON.stringify({ added_or_existing: urls.length, urls }, null, 2));
} else if (command === 'list') {
  const results = await pipeline([{ sql: `SELECT id,url,status,attempts,last_started_at,completed_at,last_error FROM crawl_site_queue ORDER BY CASE status WHEN 'processing' THEN 1 WHEN 'pending' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,id`, args: [] }]);
  console.log(JSON.stringify(rows(results[0]), null, 2));
} else if (command === 'claim') {
  const results = await pipeline([
    { sql: `UPDATE crawl_site_queue SET status='processing',attempts=attempts+1,last_started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,last_error='' WHERE id=(SELECT id FROM crawl_site_queue WHERE status IN ('pending','failed','processing') ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,id LIMIT 1)`, args: [] },
    { sql: `SELECT id,url FROM crawl_site_queue WHERE status='processing' ORDER BY last_started_at DESC,id DESC LIMIT 1`, args: [] },
  ]);
  const row = rows(results[1])[0];
  if (!row) {
    console.log(JSON.stringify({ claimed: false }));
    if (process.env.GITHUB_OUTPUT) await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_OUTPUT, 'claimed=false\n'));
    process.exit(0);
  }
  console.log(JSON.stringify({ claimed: true, ...row }));
  if (process.env.GITHUB_OUTPUT) {
    await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_OUTPUT, `claimed=true\nqueue_id=${row.id}\nqueue_url=${row.url}\n`));
  }
} else if (command === 'done') {
  const id = Number(values[0]);
  await pipeline([{ sql: `UPDATE crawl_site_queue SET status='done',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,last_error='' WHERE id=?`, args: [arg('integer', id)] }]);
  console.log(JSON.stringify({ done: true, id }));
} else if (command === 'fail') {
  const id = Number(values[0]);
  const message = values.slice(1).join(' ').slice(0, 1000);
  await pipeline([{ sql: `UPDATE crawl_site_queue SET status='failed',updated_at=CURRENT_TIMESTAMP,last_error=? WHERE id=?`, args: [arg('text', message), arg('integer', id)] }]);
  console.log(JSON.stringify({ failed: true, id, message }));
} else if (command === 'reset') {
  const id = Number(values[0]);
  await pipeline([{ sql: `UPDATE crawl_site_queue SET status='pending',completed_at=NULL,updated_at=CURRENT_TIMESTAMP,last_error='' WHERE id=?`, args: [arg('integer', id)] }]);
  console.log(JSON.stringify({ reset: true, id }));
}
