import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

export function extractHtml(html, responseUrl) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  const description = $('meta[name="description" i]').attr('content')?.replace(/\s+/g, ' ').trim() || '';
  const icon = $('link[rel~="icon" i]').attr('href') || '';
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 50000);
  const contentHash = crypto.createHash('sha256').update(`${title}\n${description}\n${text}`).digest('hex');
  const links = new Set();
  $('a[href]').each((_, el) => { try { const u = new URL($(el).attr('href'), responseUrl); if (['http:','https:'].includes(u.protocol)) links.add(u.toString()); } catch {} });
  return { title, description, iconUrl: icon ? new URL(icon, responseUrl).toString() : '', extractedText: text, contentHash, links: [...links].slice(0, 500) };
}
