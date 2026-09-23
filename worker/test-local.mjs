import worker from './src/index.js';

const rows = [];
const ftsRows = [];
const db = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes('INSERT INTO search_pages (')) {
              const [url, title, description, icon_url, search_text] = args;
              rows.push({ url, title, description, icon_url, search_text });
            } else if (sql.includes('DELETE FROM search_pages_fts')) {
              const index = ftsRows.findIndex((row) => row.url === args[0]);
              if (index >= 0) ftsRows.splice(index, 1);
            } else if (sql.includes('INSERT INTO search_pages_fts')) {
              ftsRows.push({ url: args[0], search_text: args[1] });
            }
            return { success: true };
          },
        };
      },
    };
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
const row = rows[0];
const expected = 'وزارة الأوقاف الموقع الرسمي أهلا بيك في الموقع الرسمي لوزارة الأوقاف وزارة، الأوقاف، الفتوى هذا المقتطف يدخل في نص البحث الموحد karam.com';
if (response.status !== 200) throw new Error(`Unexpected status: ${response.status}`);
if (body.inserted !== 1) throw new Error(`Unexpected inserted count: ${body.inserted}`);
if (row.url !== 'karam.com') throw new Error(`URL was not reduced to domain: ${row.url}`);
if (row.search_text !== expected) throw new Error(`Unexpected search_text: ${row.search_text}`);
if (row.search_text.includes('https://') || row.search_text.includes('/some/page')) throw new Error('search_text contains protocol or path');
if (ftsRows.length !== 1 || ftsRows[0].search_text !== expected) throw new Error('FTS row was not written correctly');
console.log(JSON.stringify({ ok: true, status: response.status, body, stored_row: row, fts_row: ftsRows[0] }, null, 2));
