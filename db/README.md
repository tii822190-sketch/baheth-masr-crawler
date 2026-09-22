# قاعدة البيانات المحلية

قاعدة التشغيل الوحيدة هي `db/crawler.sqlite`. تُحفظ داخل المستودع لأن Workflows الخاصة بالاكتشاف والفهرسة والمزامنة تعمل بالتتابع على الملف نفسه، ثم تحفظ التغييرات في Git.

## الجداول التطبيقية

| الجدول | الأعمدة المهمة | الاستخدام |
| --- | --- | --- |
| `sites` | `url`, `crawl_status`, `discovery_cursor`, `created_at`, `updated_at` | سجل المواقع ونقطة الاستكمال الخاصة باكتشاف Sitemap والروابط |
| `site_pages` | `site_id`, `url`, `crawl_status`, `crawl_attempts` | طابور الصفحات التي اكتشفها العنكبوت ولم تُفهرس بعد |
| `index_results` | `url`, `title`, `description`, `icon_url`, `keywords`, `snippet`, `created_at`, `updated_at` | نتائج الفهرسة المكتملة التي تنتظر المزامنة إلى Turso |

جميع الروابط في `sites` و`site_pages` و`index_results` فريدة. ويرتبط كل صف في `site_pages` بموقع عبر `site_id` مع حذف الصفوف التابعة تلقائيًا عند حذف الموقع. توجد فهارس على حالة الطابور، وعلى الموقع، وعلى رابط نتيجة الفهرسة.

## الحالات

حالات `sites` هي `pending` و`processing` و`completed` و`incomplete` و`not_pages` و`failed` و`error`. يختار العنكبوت `pending` افتراضيًا، ويمكنه استئناف `incomplete` عند ضبط `DISCOVERY_RESUME_INCOMPLETE=true`.

حالات `site_pages` المستخدمة أثناء الزحف هي `pending` و`queued` و`processing` و`needs_review` و`corrupt`. تعاد الصفحات المتوقفة في `processing` إلى `pending` عند بدء دفعة جديدة. الصفحة الناجحة تُنقل إلى `index_results` ثم تُحذف من الطابور. الصفحة التي تفشل تنتقل إلى `needs_review`، ثم إلى `corrupt` وتُحذف بعد تجاوز حد المحاولات.

## التهيئة والتحقق

ينفذ `crawler/src/db.mjs` التهيئة عند كل تشغيل للـ CLI. ينشئ الجداول والفهارس عند غيابها، ويضيف `discovery_cursor` إلى قواعد البيانات القديمة، ويعيد بناء الجداول القديمة إذا كان قيد حالات المواقع لا يتضمن الحالات الحالية. وفي النهاية ينفذ `PRAGMA integrity_check` ويرفض التشغيل إذا لم تكن النتيجة `ok`.

لتهيئة القاعدة أو التحقق منها محليًا:

```bash
npm run db:init
```

يمكن تغيير مسار القاعدة عبر `CRAWLER_INPUT_DB_PATH` في CLI أو `CRAWLER_DB_PATH` في أدوات الاكتشاف والمزامنة، بحسب الأداة المستخدمة. المسار الافتراضي هو `db/crawler.sqlite`.

## دورة البيانات

يضيف `tools/discovery-spider.mjs` الروابط المقبولة إلى `site_pages` فقط؛ ولا يفحص صلاحية كل صفحة أثناء الاكتشاف. يقرأ `crawler/src/crawl.mjs` الطابور، ويكتب الصفحات المكتملة إلى `index_results`.

ينقل `tools/sync-to-turso.mjs` النتائج إلى جدول Turso ذي الأعمدة الستة `url` و`title` و`description` و`icon_url` و`snippet` و`keywords`. وبعد نجاح النقل والتحقق يحذف الصفوف المنقولة من `index_results` داخل معاملة محلية واحدة. لذلك لا تُعد `index_results` نسخة أرشيفية طويلة الأجل؛ النسخة طويلة الأجل موجودة في `search_pages` و`search_pages_fts` داخل Turso.

لا توجد قاعدة staging أو قاعدة خارجية أخرى في مسار التشغيل الأساسي.
