# ربط الزاحف بجدول Google Sheets للتجربة

## 1. إنشاء الجدول

أنشئ Google Sheet جديدًا، ثم افتح **Extensions → Apps Script**، والصق محتوى `Code.txt` كاملًا.

## 2. إنشاء التبويبات والأعمدة

من محرر Apps Script شغّل الدالة:

```text
setupSheets
```

سيتم إنشاء أربعة تبويبات:

- `IndexedSites`: المواقع التي دخلت أو فُهرست.
- `IndexedPages`: الصفحات والروابط الداخلية المرشحة للفهرسة.
- `CrawlResults`: كل نتيجة زحف في صف مستقل.
- `LinkDiscoveries`: كل رابط اكتشفه الزاحف ومصدره.

## 3. إضافة حماية بسيطة

شغّل:

```javascript
setCrawlerToken('ضع-رمزًا-طويلًا-هنا');
```

احتفظ بالرمز ولا تضعه في المستودع.

## 4. نشر Web App

من Apps Script:

1. Deploy → New deployment.
2. Type: Web app.
3. Execute as: Me.
4. Who has access: Anyone with the link.
5. انسخ رابط Web App.

## 5. إرسال نتيجة اختبار

بعد تشغيل الزاحف محليًا:

```bash
GOOGLE_SHEETS_WEB_APP_URL='https://script.google.com/macros/s/ضع-المعرف/exec' \
GOOGLE_SHEETS_TOKEN='نفس-الرمز' \
node integrations/google-sheets-export.mjs
```

## ماذا يُرسل؟

يُرسل:

- العنوان الأصلي.
- الوصف الأصلي.
- الخلاصة.
- `search_snippet`.
- الرابط المطلوب والنهائي.
- المحتوى النصي المنظف.
- الروابط الداخلية والخارجية والاجتماعية.
- حالة HTTP وزمن الاستجابة وبصمة المحتوى.
- الروابط المكتشفة.

كل نتيجة زحف تُضاف إلى `CrawlResults` كصف جديد، ولا تستبدل الصفوف السابقة.

## تنبيه

هذه نسخة اختبار باستخدام Google Sheets. عند اعتماد الزاحف ننقل نفس الأعمدة إلى Turso أو قاعدة تشغيل فعلية. لا تضع رمز Google Web App أو أي بيانات حساسة داخل GitHub.
