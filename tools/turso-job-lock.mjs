import process from 'node:process';

const rawUrl = process.env.TURSO_CRAWLER_DATABASE_URL;
const token = process.env.TURSO_CRAWLER_AUTH_TOKEN;
const lockName = process.env.CRAWLER_LOCK_NAME || 'baheth-crawler-staging-write';
const ownerId = process.env.CRAWLER_LOCK_OWNER || `${process.env.GITHUB_WORKFLOW || 'local'}:${process.env.GITHUB_JOB || 'job'}`;
const runId = process.env.CRAWLER_LOCK_RUN_ID || process.env.GITHUB_RUN_ID || `local-${process.pid}`;
const ttlMinutes = Math.max(10, Number(process.env.CRAWLER_LOCK_TTL_MINUTES || 120));
if (!rawUrl || !token) throw new Error('TURSO_CRAWLER_DATABASE_URL and TURSO_CRAWLER_AUTH_TOKEN are required');
const baseUrl = rawUrl.replace(/^libsql:\/\//, 'https://').replace(/^turso:\/\//, 'https://').replace(/\/$/, '');
const arg = (type, value) => ({ type, value: String(value) });
async function pipeline(statements) {
  const response = await fetch(`${baseUrl}/v2/pipeline`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [...statements.map(stmt => ({ type: 'execute', stmt })), { type: 'close' }] }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Turso HTTP ${response.status}: ${JSON.stringify(body)}`);
  const errors = (body.results || []).filter((x) => x.type === 'error' || x.response?.error);
  if (errors.length) throw new Error(`Turso SQL error: ${JSON.stringify(errors.slice(0, 2))}`);
  return body.results || [];
}
function rows(result) {
  const r = result?.response?.result;
  const cols = (r?.cols || []).map((c) => typeof c === 'string' ? c : c.name);
  return (r?.rows || []).map((row) => Object.fromEntries(row.map((v, i) => [cols[i], v?.value ?? v])));
}
const [command] = process.argv.slice(2);
if (!['acquire', 'heartbeat', 'release', 'recover'].includes(command)) throw new Error('Usage: acquire|heartbeat|release|recover');
const common = [arg('text', lockName), arg('text', ownerId), arg('text', runId)];
if (command === 'acquire') {
  const results = await pipeline([
    { sql: `INSERT INTO job_locks(lock_name,owner_id,run_id,acquired_at,heartbeat_at,expires_at,metadata_json) VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,datetime('now','+'||?||' minutes'),?) ON CONFLICT(lock_name) DO UPDATE SET owner_id=excluded.owner_id,run_id=excluded.run_id,acquired_at=CURRENT_TIMESTAMP,heartbeat_at=CURRENT_TIMESTAMP,expires_at=excluded.expires_at,metadata_json=excluded.metadata_json WHERE job_locks.expires_at<=CURRENT_TIMESTAMP OR job_locks.owner_id=?`, args: [...common, arg('integer', ttlMinutes), arg('text', JSON.stringify({ workflow: process.env.GITHUB_WORKFLOW || '', job: process.env.GITHUB_JOB || '' })), arg('text', ownerId)] },
    { sql: 'SELECT lock_name,owner_id,run_id,expires_at FROM job_locks WHERE lock_name=?', args: [arg('text', lockName)] },
  ]);
  const row = rows(results[1])[0];
  if (!row || row.owner_id !== ownerId || row.run_id !== runId) { console.error(JSON.stringify({ acquired: false, lock: row || null })); process.exit(75); }
  await pipeline([{ sql: `INSERT INTO job_lock_events(lock_name,owner_id,run_id,event,detail) VALUES(?,?,?,?,?)`, args: [...common, arg('text', 'acquired'), arg('text', `ttl_minutes=${ttlMinutes}`)] }]);
  console.log(JSON.stringify({ acquired: true, ...row }));
} else if (command === 'heartbeat') {
  const results = await pipeline([{ sql: `UPDATE job_locks SET heartbeat_at=CURRENT_TIMESTAMP,expires_at=datetime('now','+'||?||' minutes') WHERE lock_name=? AND owner_id=? AND run_id=?`, args: [arg('integer', ttlMinutes), arg('text', lockName), arg('text', ownerId), arg('text', runId)] }, { sql: 'SELECT lock_name,owner_id,run_id,expires_at FROM job_locks WHERE lock_name=?', args: [arg('text', lockName)] }]);
  const row = rows(results[1])[0];
  if (!row || row.owner_id !== ownerId || row.run_id !== runId) { console.error(JSON.stringify({ heartbeat: false, lock: row || null })); process.exit(75); }
  console.log(JSON.stringify({ heartbeat: true, ...row }));
} else if (command === 'release') {
  await pipeline([{ sql: `INSERT INTO job_lock_events(lock_name,owner_id,run_id,event,detail) SELECT lock_name,owner_id,run_id,'released','' FROM job_locks WHERE lock_name=? AND owner_id=? AND run_id=?`, args: [arg('text', lockName), arg('text', ownerId), arg('text', runId)] }, { sql: 'DELETE FROM job_locks WHERE lock_name=? AND owner_id=? AND run_id=?', args: [arg('text', lockName), arg('text', ownerId), arg('text', runId)] }]);
  console.log(JSON.stringify({ released: true, lock_name: lockName }));
} else {
  const results = await pipeline([{ sql: `DELETE FROM job_locks WHERE expires_at<=CURRENT_TIMESTAMP`, args: [] }, { sql: 'SELECT lock_name,owner_id,run_id,expires_at FROM job_locks ORDER BY lock_name', args: [] }]);
  console.log(JSON.stringify({ recovered: true, removed: results[0]?.response?.result?.affected_row_count || 0, locks: rows(results[1]) }));
}
