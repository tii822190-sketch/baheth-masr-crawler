import worker from './src/index.js';

const rows = [];
const ftsRows = [];
let lastChanges = 0;
const db = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO search_pages_fts_keys')) {
              const [url, search_text] = args;
              if (!ftsRows.some((row) => row.url === url)) ftsRows.push({ url, search_text });
            } else if (sql.includes('INSERT OR IGNORE INTO search_pages (')) {
              const [url, title, description, icon_url] = args;
              if (rows.some((row) => row.url === url)) lastChanges = 0;
              else { rows.push({ url, title, description, icon_url }); lastChanges = 1; }
            }
            return { success: true };
          },
        };
      },
    };
  },
  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
  },
};

const request = new Request('https://baheth-masr-ingest.workers.dev/', {
  method: 'POST',
  headers: { Authorization: 'Bearer local-test-token', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://www.karam.com/some/page?x=1',
    title: 'وزارة الأوقاف الموقع الرسمي',
    description: 'أهلا بيك في الموقع الرسمي لوزارة الأوقاف',
    keywords: 'وزارة، الأوقاف، الفتوى',
    snippet: 'هذا المقتطف يدخل في نص البحث الموحد',
    icon_url: 'https://www.karam.com/favicon.ico',
  }),
});

const response = await worker.fetch(request, { DB: db, INGEST_TOKEN: 'local-test-token' });
const body = await response.json();
const duplicateRequest = new Request('https://baheth-masr-ingest.workers.dev/', {
  method: 'POST',
  headers: { Authorization: 'Bearer local-test-token', 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://www.karam.com/some/page?x=1', title: 'تغيير لا يجب كتابته' }),
});
await worker.fetch(duplicateRequest, { DB: db, INGEST_TOKEN: 'local-test-token' });
const row = rows[0];
const expected = 'وزارة الأوقاف الموقع الرسمي أهلا بيك في الموقع الرسمي لوزارة الأوقاف وزارة، الأوقاف، الفتوى هذا المقتطف يدخل في نص البحث الموحد karam.com';
if (response.status !== 200) throw new Error(`Unexpected status: ${response.status}`);
if (body.inserted !== 1) throw new Error(`Unexpected inserted count: ${body.inserted}`);
if (row.url !== 'https://www.karam.com/some/page?x=1') throw new Error(`Full page URL was not preserved: ${row.url}`);
if ('search_text' in row) throw new Error('Main row still contains search_text');
if (ftsRows.length !== 1 || ftsRows[0].search_text !== expected) throw new Error('FTS source row was not written correctly');
if (ftsRows[0].search_text.includes('https://') || ftsRows[0].search_text.includes('/some/page')) throw new Error('search_text contains protocol or path');
if (rows.length !== 1) throw new Error(`Duplicate URL was written: ${rows.length}`);
console.log(JSON.stringify({ ok: true, status: response.status, body, stored_row: row, fts_row: ftsRows[0] }, null, 2));
