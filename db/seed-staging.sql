INSERT OR IGNORE INTO sites (url,name,priority) VALUES
  ('https://bardy.pages.dev/','بردي — الموقع الرئيسي',90),
  ('https://baheth-masr-api.tii822190.workers.dev/','بردي — واجهة البحث API',80),
  ('https://www.alexu.edu.eg/','جامعة الإسكندرية',70),
  ('https://www.cairo.gov.eg/','محافظة القاهرة',70),
  ('https://asush.asu.edu.eg/','مستشفى عين شمس التخصصي',70),
  ('https://www.egypt.gov.eg/','بوابة مصر الحكومية',70);

INSERT OR IGNORE INTO site_pages (site_id,url,title,description)
SELECT id,url,name,'صفحة تجريبية للزاحف' FROM sites;
