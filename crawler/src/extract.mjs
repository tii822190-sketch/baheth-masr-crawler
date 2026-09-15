import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

const NON_CONTENT = 'script,style,noscript,template,svg,canvas,iframe,object,embed,form,button,input,select,textarea';
const BOILERPLATE = 'nav,header,footer,aside,.sidebar,.navbar,.navigation,.social,.share,.comments,#comments,.cookie,.popup,.advert,.ads,.ad,.sidebar .widget,.footer .widget';

function cleanText(value) { return value.replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,'\n').replace(/\n{3,}/g,'\n\n').trim(); }

function extractUsefulText($) {
  $(NON_CONTENT).remove();
  const root=$('body').get(0); if(!root)return '';
  const scoped=$(root); scoped.find(BOILERPLATE).remove();
  const blocks=[];
  scoped.find('article,div.post,div.post-body,.entry-content,.post-content,.widget-content,h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th').each((_,el)=>{const text=cleanText($(el).text());if(text.length>=2&&!blocks.includes(text))blocks.push(text);});
  const structured=cleanText(blocks.join('\n')); const fallback=cleanText(scoped.text());
  return (structured.length>=80?structured:fallback).slice(0,50000);
}

function cleanUrlCandidate(raw,responseUrl){if(!raw||/^(mailto:|tel:|javascript:|#|data:)/i.test(raw))return '';let value=raw.trim().replace(/^['"\s]+|['"\s]+$/g,'');const embedded=value.match(/https?:\/\/[^\s"'<>]+/i);if(embedded)value=embedded[0];try{const u=new URL(value,responseUrl);return['http:','https:'].includes(u.protocol)?u.toString():'';}catch{return '';}}

export function extractHtml(html,responseUrl){
  const $=cheerio.load(html);const title=cleanText($('title').first().text())||cleanText($('meta[property="og:title" i]').attr('content')||'');const description=cleanText($('meta[name="description" i]').attr('content')||$('meta[property="og:description" i]').attr('content')||'');const icon=$('link[rel~="icon" i]').attr('href')||$('meta[property="og:image" i]').attr('content')||'';const text=extractUsefulText($);const contentHash=crypto.createHash('sha256').update(`${title}\n${description}\n${text}`).digest('hex');const links=new Set();$('a[href]').each((_,el)=>{const url=cleanUrlCandidate($(el).attr('href'),responseUrl);if(url)links.add(url);});let iconUrl='';try{iconUrl=icon?new URL(icon,responseUrl).toString():'';}catch{}return{title,description,iconUrl,extractedText:text,contentHash,links:[...links].slice(0,100)};
}
