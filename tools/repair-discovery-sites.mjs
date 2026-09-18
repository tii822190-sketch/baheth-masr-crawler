import Database from 'better-sqlite3';

const db = new Database(process.env.CRAWLER_INPUT_DB_PATH || 'db/links.sqlite');
db.pragma('foreign_keys = ON');
const repair = db.transaction(() => {
  const site = db.prepare('SELECT id,url,discovery_status FROM sites WHERE id=2').get();
  if (!site) throw new Error('site_2_not_found');
  db.prepare("UPDATE sites SET discovery_status='processing', last_discovered_at=NULL WHERE id=2").run();
  db.prepare('DELETE FROM discovery_sitemap_cursor WHERE site_id=2').run();
  const removed = db.prepare('SELECT id,url FROM sites WHERE id=3').get();
  if (removed) {
    db.prepare('DELETE FROM crawl_observations WHERE target_id IN (SELECT id FROM crawl_targets WHERE site_id=3)').run();
    db.prepare('DELETE FROM crawl_targets WHERE site_id=3').run();
    db.prepare('DELETE FROM crawl_discoveries WHERE source_site_id=3').run();
    db.prepare('DELETE FROM discovery_queue WHERE site_id=3').run();
    db.prepare('DELETE FROM discovery_sitemap_cursor WHERE site_id=3').run();
    db.prepare('DELETE FROM site_pages WHERE site_id=3').run();
    db.prepare('DELETE FROM sites WHERE id=3').run();
  }
  return {site2:{id:2,status:'processing'},site3_deleted:Boolean(removed),site3:removed||null};
});
console.log(JSON.stringify(repair(), null, 2));
db.close();
