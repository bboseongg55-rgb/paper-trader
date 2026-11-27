// Earnings reports, the stock news the strategies can be tested on (owner 2026-11-27: "주식 정보나 스크립트(주식 뉴스)
// 같은 것들 커넥터에서 뽑아오고 그걸로도 매매에 기반되게"). The connectors work only inside a chat, so the same kind of
// public source is read here: Nasdaq's earnings calendar (api.nasdaq.com, no key; SEC's servers answer 403 to GitHub's).
// For every day it lists the companies that reported, their EPS, the analysts' consensus forecast, the surprise in % and
// the number of estimates, back to 2008 (tools/probe_events.mjs). Two files, the stock symbols as the book writes them
// with . and / turned into - (BRK-B):
//   data/hist/earnings.json.gz  hist mode: {built, from, to, seen: {date: rows}, s: {SYM: [[date, eps, forecast,
//                               surprise %, estimates], ...]}} for every weekday since 2008-07-01 (resumable: a run
//                               fetches only the days the file lacks, within LONG_MIN minutes)
//   data/earnings.json          recent mode (each evening): the last 15 weekdays again, so a report the history lacks
//                               is there the next day, and the next 30 days' scheduled reports
//                               {built, s: {SYM: [[date, eps, forecast, surprise, estimates, time]]}, next: {SYM: [date,
//                               time, forecast]}}; time is pre (before the open), post (after the close) or '' (not given)
// Usage: node tools/earnings.mjs hist | recent
import fs from 'node:fs';
import zlib from 'node:zlib';

const MODE = process.argv[2] || 'recent';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const norm = (s) => String(s || '').toUpperCase().replace(/[./]/g, '-');
const T0 = Date.now(), BUDGET = (+process.env.LONG_MIN || 40) * 60e3, left = () => BUDGET - (Date.now() - T0);
const num = (v) => { if (v == null) return null; const s = String(v).replace(/[$,\s]/g, ''); const neg = /^\(.*\)$/.test(s); const x = parseFloat(s.replace(/[()]/g, '')); return Number.isFinite(x) ? (neg ? -x : x) : null; };
const TIME = { 'time-pre-market': 'pre', 'time-after-hours': 'post' };

async function day(d) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, { headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      return (j && j.data && j.data.rows) || [];
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;
}
const row = (x, d) => [d, num(x.eps), num(x.epsForecast), num(x.surprise), num(x.noOfEsts) || 0, TIME[x.time] || ''];
function weekdays(a, b) { const out = []; for (let t = Date.parse(a); t <= Date.parse(b); t += 864e5) { const w = new Date(t).getUTCDay(); if (w > 0 && w < 6) out.push(ymd(t)); } return out; }

if (MODE === 'hist') {
  const F = 'data/hist/earnings.json.gz';
  let H = { from: '2008-07-01', seen: {}, s: {} };
  try { H = JSON.parse(zlib.gunzipSync(fs.readFileSync(F))); } catch {}
  const to = ymd(Date.now() - 864e5), want = weekdays(H.from, to).filter((d) => !(d in H.seen));
  console.log('earnings history: days to fetch', want.length, 'have', Object.keys(H.seen).length);
  const save = () => {
    for (const k of Object.keys(H.s)) H.s[k].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    H.built = new Date().toISOString(); H.to = Object.keys(H.seen).sort().pop() || null;
    fs.writeFileSync(F, zlib.gzipSync(JSON.stringify(H)));
  };
  let n = 0, last = Date.now();
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (want.length && left() > 2 * 60e3) {
      const d = want.shift(), rows = await day(d);
      if (rows == null) continue;                       // left unseen: the next run asks again
      H.seen[d] = rows.length;
      for (const x of rows) {
        const k = norm(x.symbol); if (!k) continue;
        const r = row(x, d).slice(0, 5);
        const a = (H.s[k] = H.s[k] || []); if (!a.some((y) => y[0] === d)) a.push(r);
      }
      if (++n % 250 === 0) console.log('days', n, 'left', want.length, 'symbols', Object.keys(H.s).length);
      if (Date.now() - last > 4 * 60e3) { last = Date.now(); save(); }
      await sleep(150);
    }
  }));
  save();
  console.log('earnings history: days', Object.keys(H.seen).length, 'symbols', Object.keys(H.s).length, 'to', H.to);
} else {
  const now = Date.now(), past = weekdays(ymd(now - 21 * 864e5), ymd(now)).slice(-15), ahead = weekdays(ymd(now + 864e5), ymd(now + 30 * 864e5));
  const out = { built: new Date().toISOString(), s: {}, next: {} };
  for (const d of past) {
    const rows = await day(d); if (!rows) continue;
    for (const x of rows) { const k = norm(x.symbol); if (k && num(x.eps) != null) (out.s[k] = out.s[k] || []).push(row(x, d)); }
    await sleep(250);
  }
  for (const d of ahead) {
    const rows = await day(d); if (!rows) continue;
    for (const x of rows) { const k = norm(x.symbol); if (k && !out.next[k]) out.next[k] = [d, TIME[x.time] || '', num(x.epsForecast)]; }
    await sleep(250);
  }
  fs.writeFileSync('data/earnings.json', JSON.stringify(out));
  console.log('earnings recent: reported', Object.keys(out.s).length, 'scheduled', Object.keys(out.next).length);
}
