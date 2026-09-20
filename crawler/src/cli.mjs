import { initDb, db, resultsDb } from './db.mjs';
import { run } from './crawl.mjs';
const command = process.argv[2] || 'manual';
initDb();
if (command === 'init') { console.log('local crawler database initialized'); db.close(); resultsDb.close(); process.exit(0); }
try { console.log(JSON.stringify(await run(command), null, 2)); } catch (error) { console.error(error); process.exitCode=1; } finally { db.close(); resultsDb.close(); }
