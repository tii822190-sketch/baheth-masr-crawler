# Google Sheets — قاعدة تجربة بسيطة للزاحف

هذا الإصدار يستخدم **تبويبًا واحدًا فقط** باسم `CrawlResults`.

## الأعمدة

```text
result_id
run_type
requested_url
canonical_url
response_url
http_status
crawl_status
content_type
content_length
title
description
summary
search_snippet
icon_url
extracted_text
content_hash
links_json
internal_links_json
external_links_json
social_links_json
discovered_links_count
duration_ms
error_message
fetched_at
```

## الإعداد من الصفر

1. افتح Google Sheet.
2. افتح **Extensions → Apps Script**.
3. الصق محتوى `Code.txt` كاملًا.
4. احفظ المشروع.
5. شغّل الدالة `resetEverything()` مرة واحدة.

> الدالة `resetEverything()` تحذف كل التبويبات الأخرى وكل بياناتها، ثم تنشئ تبويبًا واحدًا نظيفًا باسم `CrawlResults`. لا تشغّلها مرة أخرى بعد بدء حفظ النتائج إلا إذا أردت حذف البيانات من جديد.

## حماية Web App

شغّل مرة واحدة:

```javascript
setCrawlerToken('ضع-رمزًا-طويلًا-وسريًا-هنا');
```

## النشر

من Apps Script اختر:

```text
Deploy → New deployment → Web app
```

الإعدادات:

```text
Execute as: Me
Who has access: Anyone with the link
```

انسخ رابط Web App الذي ينتهي غالبًا بـ `/exec`.

## تشغيل الزاحف يدويًا ثم إرسال النتيجة

بعد أن يشغّل الزاحف رابطًا محددًا:

```bash
CRAWLER_LIMIT=0 \
CRAWLER_MANUAL_URL='https://elsabagh.com' \
npm run crawl:manual
```

ثم أرسل آخر نتيجة إلى Google Sheet:

```bash
GOOGLE_SHEETS_WEB_APP_URL='https://script.google.com/macros/s/ضع-المعرف/exec' \
GOOGLE_SHEETS_TOKEN='نفس-الرمز' \
npm run export:google-sheets
```

كل تشغيل يدوي يضيف صفًا جديدًا في `CrawlResults`.

## ما يسجل في الصف

- الرابط المطلوب والرابط النهائي.
- العنوان والوصف الأساسي الأصليان.
- الخلاصة و`search_snippet` المحسن.
- النص المنظف من CSS وJavaScript.
- كل الروابط والروابط الداخلية والخارجية والاجتماعية بصيغة JSON.
- الحالة والحجم والزمن والبصمة ورسالة الخطأ.

لا توجد جدولة أو جداول صفحات منفصلة في هذه النسخة التجريبية.
