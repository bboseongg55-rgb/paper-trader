// Stock news for the page (owner 2026-11-27: "주식 정보나 스크립트(주식 뉴스)"): the latest headlines and company press
// releases of every stock the account holds, from Nasdaq's public news feeds (no key; they answer GitHub's servers,
// tools/probe_events.mjs). Each headline gets a tone from a short word list (호재/악재/중립). Headlines are NOT a reason
// to trade: no free source keeps years of them, so no backtest can prove a rule on them (owner 2026-11-26: only what a
// backtest proved trades). Every headline is kept month by month in data/news/, so a rule can be tested once a few
// years have built up. Writes data/news.json {built, s: {SYM: [{d, title, pub, url, kind, tone}]}}.
// Run each evening and every 30 minutes in the session (tools/session.sh).
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const H = { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const day = (s) => { const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${MON[m[1]]}-${m[2].padStart(2, '0')}` : null; };
// tone: whole words, lower case; a headline with more good words than bad is 호재 (1), more bad 악재 (−1)
const GOOD = ['beat', 'beats', 'tops', 'raises', 'raised', 'upgrade', 'upgraded', 'outperform', 'record', 'surge', 'surges', 'soars', 'jumps', 'rallies', 'gains', 'buyback', 'repurchase', 'approval', 'approved', 'wins', 'partnership', 'strong', 'growth', 'boosts', 'hikes', 'dividend increase', 'expands', 'breakthrough'];
const BAD = ['miss', 'misses', 'cuts', 'cut', 'downgrade', 'downgraded', 'underperform', 'lawsuit', 'sued', 'probe', 'investigation', 'recall', 'plunge', 'plunges', 'sinks', 'tumbles', 'falls', 'slumps', 'warning', 'warns', 'layoffs', 'halts', 'fraud', 'delay', 'delays', 'weak', 'loss', 'losses', 'bankruptcy', 'subpoena', 'resigns'];
const tone = (t) => { const s = ' ' + String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + ' '; let g = 0, b = 0; for (const w of GOOD) if (s.includes(' ' + w + ' ')) g++; for (const w of BAD) if (s.includes(' ' + w + ' ')) b++; return g > b ? 1 : b > g ? -1 : 0; };

async function feed(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: H }); if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; } if (!r.ok) return []; const j = await r.json(); return (j && j.data && j.data.rows) || []; } catch { await sleep(800 * (i + 1)); }
  }
  return [];
}
const held = readJSON('data/held.json', null);
const state = readJSON('data/state.json', {});
const syms = new Set();
for (const s of (held && (held.syms || held)) || []) if (typeof s === 'string') syms.add(s);
for (const p of ((state.account || {}).open) || []) if (p && p.sym) syms.add(p.sym);
const list = [...syms].filter((s) => /^[A-Z][A-Z0-9./]{0,9}$/.test(s)).slice(0, 40);
const out = { built: new Date().toISOString(), s: {} }, logged = [];
for (const s of list) {
  const q = s.replace('/', '.');
  const news = await feed(`https://www.nasdaq.com/api/news/topic/articlebysymbol?q=${encodeURIComponent(q)}|stocks&offset=0&limit=8&fallback=false`);
  await sleep(250);
  const pr = await feed(`https://www.nasdaq.com/api/news/topic/press_release?q=symbol:${encodeURIComponent(q)}|assetclass:stocks&limit=4&offset=0`);
  await sleep(250);
  const rows = [];
  for (const [kind, arr] of [['pr', pr], ['news', news]]) for (const x of arr) {
    if (!x || !x.title || !x.url) continue;
    const rel = (x.related_symbols || []).map((y) => String(y).split('|')[0].toUpperCase());
    if (kind === 'news' && rel.length && !rel.includes(q.toUpperCase())) continue;   // the feed's market-wide fallback
    const url = x.url.startsWith('http') ? x.url : 'https://www.nasdaq.com' + x.url;
    if (rows.some((r) => r.url === url)) continue;
    rows.push({ d: day(x.created), ago: x.ago || null, title: String(x.title).slice(0, 200), pub: x.publisher || (kind === 'pr' ? '보도자료' : null), url, kind, tone: tone(x.title) });
  }
  rows.sort((a, b) => ((b.d || '') < (a.d || '') ? -1 : (b.d || '') > (a.d || '') ? 1 : 0));
  out.s[s] = rows.slice(0, 8);
  for (const r of rows) logged.push([r.d, s, r.kind, r.tone, r.title, r.pub, r.url]);
}
fs.writeFileSync('data/news.json', JSON.stringify(out));
// the running record, one file per month, a headline once
fs.mkdirSync('data/news', { recursive: true });
const ym = new Date().toISOString().slice(0, 7), lf = `data/news/${ym}.json`, log = readJSON(lf, []), seen = new Set(log.map((r) => r[6]));
let added = 0;
for (const r of logged) if (!seen.has(r[6])) { log.push(r); seen.add(r[6]); added++; }
fs.writeFileSync(lf, JSON.stringify(log));
console.log('news', JSON.stringify({ stocks: list.length, headlines: logged.length, newInLog: added }));
