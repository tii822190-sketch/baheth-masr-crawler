# Baheth Masr Crawler

مستودع مستقل لزاحف بردي اليومي والأسبوعي. النسخة الحالية **تجريبية معزولة**: تجمع الملاحظات والاكتشافات في SQLite ولا تعدل بيانات البحث الإنتاجية.

## البنية

- `crawler/`: محرك الزحف Node.js.
- `migrations/`: مخطط قاعدة staging.
- `db/`: قاعدة محلية وبيانات seed تجريبية.
- `.github/workflows/crawler.yml`: تشغيل يدوي ويومي وأسبوعي عبر GitHub Actions.
- `worker/`: Worker إداري يطلق Workflow عبر GitHub API.

## تشغيل محلي

```bash
npm install
npm test
npm run db:init
CRAWLER_LIMIT=5 npm run crawl:daily
```

النتيجة في `db/staging.sqlite`. لا يوجد اتصال بالإنتاج ولا يحتاج Google Sheets؛ SQLite أنسب للاختبار وقابل للنقل إلى Turso لاحقًا. يمكن تصدير الجداول إلى CSV عند الحاجة.

## الجدولة

- يوميًا: فحص محدود للمواقع.
- أسبوعيًا: تحديث أوسع للـmetadata.
- يدويًا: `workflow_dispatch` مع `limit` يصل إلى 100 في مرحلة الاختبار.

## Worker الإداري في حساب زميل الفريق

يُنشأ Worker باسم `baheth-masr-crawler-control` في حساب Cloudflare الخاص بالمسؤول عن الزاحف. بعد ربط المستودع بحسابه:

```bash
wrangler secret put GITHUB_TOKEN
wrangler secret put CRAWLER_CONTROL_TOKEN
wrangler deploy
```

`GITHUB_TOKEN` يجب أن يكون Fine-grained Token للمستودع فقط بصلاحية Actions: Read and write. لا نستخدم Global API Key.

تشغيل يدوي:

```bash
curl -X POST https://<crawler-control-worker>/run \
  -H 'Authorization: Bearer <control-token>' \
  -H 'Content-Type: application/json' \
  -d '{"run_type":"daily_check","limit":10}'
```

## الانتقال لاحقًا إلى Turso

بعد نجاح staging، نضيف Adapter لـTurso HTTP API مع نفس الجداول. لا يتم ربط قاعدة الإنتاج أو تعديل `sites` و`site_pages` قبل مراجعة observations ومعدلات الفشل.
