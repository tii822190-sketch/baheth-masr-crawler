import { initDb, db } from './db.mjs';
import { run } from './crawl.mjs';
const command = process.argv[2] || 'daily_check';
initDb();
if (command === 'init') { console.log('staging database initialized'); process.exit(0); }
try { console.log(JSON.stringify(await run(command), null, 2)); } catch (error) { console.error(error); process.exitCode=1; } finally { db.close(); }
