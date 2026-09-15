# Baheth Masr Crawler

مستودع مستقل لزاحف بردي اليومي والأسبوعي. النسخة الحالية **تجريبية معزولة** ولا تعدل قاعدة البحث الإنتاجية.

## قاعدتان منفصلتان

1. `db/links.sqlite`: قاعدة التحكم والمدخلات، وتحتوي على المواقع والصفحات والأهداف والاكتشافات.
2. `db/results.sqlite`: قاعدة النتائج append-only؛ كل زيارة تضيف صفًا جديدًا في `crawl_results` حتى نستطيع مقارنة الزيارات عبر الزمن.

لا نستخدم Google Sheets كقاعدة تشغيل؛ يمكن تصدير `crawl_results` إلى CSV لاحقًا للتقارير البشرية، بينما SQLite أقرب إلى Turso وأسهل في الاختبار.

## Turso staging

قاعدة الزاحف منفصلة عن قاعدة المواقع والصفحات الإنتاجية. يطبق Workflow مخططات `migrations/001_crawler_staging.sql` و`002_crawler_results.sql` و`003_distribution.sql` قبل التشغيل، ثم يستخدم SQLite المحلي كنسخة تشغيل مؤقتة. في GitHub يجب إضافة السر `TURSO_CRAWLER_AUTH_TOKEN` فقط؛ عنوان قاعدة staging موجود في Workflow لأنه ليس سرًا. لا تستخدم توكن قاعدة الإنتاج هنا.

## مصادر الروابط المحدودة

- مواقع موجودة في `db/seed-staging.sql` أو تُضاف من لوحة المطور.
- نتائج DuckDuckGo عند تمرير `CRAWLER_DDG_QUERIES`، بحد أقصى 3 استعلامات و20 نتيجة لكل استعلام، مع تأخير 1.2 ثانية.
- الروابط التي يجدها الزاحف داخل الصفحات التي زارها، بحد أقصى 100 رابط لكل صفحة.
- رابط يدوي عبر `CRAWLER_MANUAL_URL`.

كل رابط جديد يدخل `crawl_discoveries` أولًا، ولا يصبح مصدرًا معتمدًا تلقائيًا.

## تشغيل محلي

```bash
npm install
npm test
rm -f db/links.sqlite db/results.sqlite
CRAWLER_LIMIT=2 npm run crawl:daily
```

اختبار DDG/الرابط اليدوي:

```bash
CRAWLER_LIMIT=2 \
CRAWLER_DDG_QUERIES='مستشفيات مصر|جامعات مصر' \
CRAWLER_MANUAL_URL='https://example.com' \
npm run crawl:manual
```

## التشغيل من اللوحة

Worker الإداري يطلق Workflow GitHub. يرسل:

```json
{"run_type":"manual","limit":10,"manual_url":"https://example.com","ddg_queries":"مستشفيات مصر|جامعات مصر"}
```

## حدود الأمان التجريبية

- لا زحف تلقائي من اكتشاف إلى اكتشاف بلا حدود.
- لا متابعة للروابط المكتشفة في نفس التشغيل؛ تُراجع أولًا.
- لا حذف أو تحديث لبيانات البحث الحالية.
- كل استجابة تحفظ في صف مستقل في `crawl_results`.
- DuckDuckGo مصدر اقتراحات محدود، وليس مصدر الحقيقة النهائي.
