// The long history for the strategy checks (owner 2026-11-26: "과거 데이터 확장", free public sources only, no keys).
// Run by .github/workflows/hist.yml (what=long). Writes into data/hist/:
//   sp500_members.json.gz  which stocks were in the S&P 500 on each date since 2009 (fja05680/sp500 on GitHub, built
//                          from the index's published changes), so a backtest only buys what was in the index then
//   yf_stocks.json.gz      Yahoo Finance daily closes (dividend and split adjusted) 2009-01 → 2024-03 for every stock
//                          the book tracks and every stock that was in the S&P 500 since 2009 and is still on Yahoo;
//                          the checks splice them onto the book's own data at 2024-01-02
//   yf_misc.json.gz        the S&P 500 index, the VIX, the bond funds the book trades, the continuous front-month futures
//                          the derivatives part trades and bitcoin and ether spot, each since 2007 → today
//   hl_funding.json.gz     Hyperliquid's hourly funding rates for BTC, ETH and SOL perpetuals since 2023 (real funding
//                          for the coin checks in place of one assumed rate)
// Delisted stocks Yahoo no longer serves are missing: the backtest still leans towards survivors (확인필요).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const put = (name, obj) => { const b = zlib.gzipSync(JSON.stringify(obj)); fs.writeFileSync(`data/hist/${name}.json.gz`, b); console.log('wrote', name, (b.length / 1e6).toFixed(2) + 'MB'); };
const old = (name) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(`data/hist/${name}.json.gz`))); } catch { return null; } };
// a run has LONG_MIN minutes (the workflow step allows a little more); the stocks stop early, keep what they have and
// the next run picks up where this one stopped
const T0 = Date.now(), BUDGET = (+process.env.LONG_MIN || 40) * 60e3, left = () => BUDGET - (Date.now() - T0);
// when Yahoo says "too many requests" every worker waits together, and the wait grows while it keeps saying so
let coolUntil = 0, cool = 15e3, n429 = 0;
async function get(url, opt = {}) {
  for (let i = 0; i < 6; i++) {
    const w = coolUntil - Date.now(); if (w > 0) await sleep(w);
    try {
      const r = await fetch(url, Object.assign({ headers: { 'User-Agent': UA, Accept: '*/*' } }, opt));
      if (r.status === 404) return null;
      if (r.status === 429) { n429++; coolUntil = Math.max(coolUntil, Date.now() + cool); cool = Math.min(cool * 1.5, 120e3); i--; if (left() < 60e3) return null; continue; }
      if (r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      cool = Math.max(15e3, cool * 0.9);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return opt.text ? await r.text() : await r.json();
    } catch (e) { if (i === 5) { console.log('failed', url.slice(0, 120), String(e.message || e).slice(0, 80)); return null; } await sleep(1000 * (i + 1)); }
  }
  return null;
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
// Yahoo Finance daily bars: {dates, c (adjusted close)}; the date is the exchange's local day
async function yahoo(sym, from, to) {
  const q = `${encodeURIComponent(sym)}?period1=${Math.floor(Date.parse(from) / 1000)}&period2=${Math.floor(Date.parse(to) / 1000)}&interval=1d&includeAdjustedClose=true&events=div%2Csplit`;
  let j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${q}`);
  if (!j || !j.chart || !j.chart.result) j = await get(`https://query2.finance.yahoo.com/v8/finance/chart/${q}`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return null;
  const off = (r.meta && r.meta.gmtoffset) || 0, ts = r.timestamp, ad = (r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || r.indicators.quote[0].close;
  const dates = [], c = [];
  for (let i = 0; i < ts.length; i++) { const v = ad[i]; if (v > 0) { dates.push(ymd((ts[i] + off) * 1000)); c.push(+v.toPrecision(6)); } }
  return dates.length ? { dates, c } : null;
}
const norm = (s) => String(s).trim().toUpperCase().replace(/[./]/g, '-');
fs.mkdirSync('data/hist', { recursive: true });

// 1. the index, the VIX, the bond funds, the futures and the coins' spot price (small: first, so a slow Yahoo day
// still gets the futures and coin checks their record; what fails keeps an earlier run's copy)
{
  const list = ['^GSPC', '^VIX', 'VCIT', 'VCSH', 'IGIB', 'EMB', 'BNDX', 'IGOV',
    'ES=F', 'NQ=F', 'YM=F', 'RTY=F', 'ZT=F', 'ZF=F', 'ZN=F', 'ZB=F', 'CL=F', 'GC=F', 'SI=F', 'HG=F', 'BTC=F', 'ETH=F', 'BTC-USD', 'ETH-USD'];
  const out = old('yf_misc') || {};
  for (const s of list) { const r = await yahoo(s, '2007-01-01', ymd(Date.now() + 864e5)); if (r) out[s] = Object.fromEntries(r.dates.map((d, i) => [d, r.c[i]])); console.log('misc', s, r ? r.dates.length : 'none'); await sleep(400); }
  put('yf_misc', out);
}
// 2. real funding on Hyperliquid's perpetuals (hourly rate per hour held)
{
  const out = {};
  for (const c of ['BTC', 'ETH', 'SOL']) {
    const rows = []; let t = Date.parse('2023-05-12T00:00:00Z');
    for (let k = 0; k < 200 && t < Date.now(); k++) {
      const j = await get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ type: 'fundingHistory', coin: c, startTime: t }) });
      if (!Array.isArray(j) || !j.length) break;
      for (const r of j) rows.push([r.time, +(+r.fundingRate).toPrecision(5)]);
      const nt = j[j.length - 1].time + 1; if (nt <= t) break; t = nt;
      await sleep(300);
    }
    out[c] = rows.length ? rows : ((old('hl_funding') || {})[c] || []); console.log('funding', c, rows.length, rows.length && ymd(rows[0][0]), rows.length && ymd(rows[rows.length - 1][0]));
  }
  put('hl_funding', out);
}
// 3. S&P 500 membership by date (the dataset's newest CSV, found through GitHub's public API)
let members = null;
{
  const ls = await get('https://api.github.com/repos/fja05680/sp500/contents');
  const f = Array.isArray(ls) ? ls.find((x) => /Historical Components/i.test(x.name) && /\.csv$/i.test(x.name)) : null;
  const csv = f ? await get(f.download_url, { text: true }) : null;
  if (csv) {
    const rows = [];
    for (const line of csv.split(/\r?\n/).slice(1)) {
      const m = /^(\d{4}-\d{2}-\d{2}),"?([^"]*)"?$/.exec(line.trim());
      if (m && m[1] >= '2008-06-01') rows.push([m[1], m[2].split(',').map(norm).filter(Boolean).sort().join(',')]);
    }
    const out = []; let last = null;                   // only the dates the list changed
    for (const [d, t] of rows) if (t !== last) { out.push([d, t]); last = t; }
    members = out;
    put('sp500_members', { src: f.name, rows: out });
    console.log('members rows', out.length, out[0] && out[0][0], out.length && out[out.length - 1][0]);
  } else console.log('S&P 500 membership not found');
}
// 4. stocks: the book's own list and every S&P 500 member since 2009. Saved as they come in (a run that runs out of
// time keeps what it has); the next run fetches only what is still missing
{
  const FROM = '2009-01-01', TO = '2024-03-01';
  const seed = JSON.parse(fs.readFileSync('data/seed.json', 'utf8'));
  const own = seed.syms.map((x) => norm(x.s));
  const past = new Set(); for (const [, t] of members || []) for (const s of t.split(',')) past.add(s);
  const syms = [...new Set(own.concat([...past]))].sort();
  // what an earlier run already has: unpack it to {dates, c} per stock
  const prev = old('yf_stocks'), out = {}, tries = {};
  if (prev && prev.from === FROM && prev.to === TO && prev.s) {
    for (const [s, [i0, arr]] of Object.entries(prev.s)) { const dates = [], c = []; arr.forEach((v, k) => { if (v > 0) { dates.push(prev.dates[i0 + k]); c.push(v); } }); if (dates.length) out[s] = { dates, c }; }
    Object.assign(tries, prev.tries || {});
  }
  // a stock Yahoo has said nothing about twice is not asked for again
  const work = syms.filter((s) => !out[s] && (tries[s] || 0) < 2);
  console.log('stocks', syms.length, 'have', Object.keys(out).length, 'to fetch', work.length);
  const save = (final) => {
    const cal = [...new Set(Object.values(out).flatMap((r) => r.dates))].sort();
    const at = new Map(cal.map((d, i) => [d, i])), pack = {};
    for (const [s, r] of Object.entries(out)) {
      const i0 = at.get(r.dates[0]), arr = new Array(cal.length - i0).fill(null);
      r.dates.forEach((d, k) => { arr[at.get(d) - i0] = r.c[k]; });
      pack[s] = [i0, arr];
    }
    const pending = syms.filter((s) => !out[s] && (tries[s] || 0) < 2).length;
    put('yf_stocks', { from: FROM, to: TO, dates: cal, s: pack, want: syms.length, pending, missing: syms.filter((s) => !out[s] && (tries[s] || 0) >= 2).length, tries, own: own.length });
    if (final) console.log('stocks have', Object.keys(out).length, 'pending', pending, 'Yahoo 429s', n429);
  };
  let n = 0, lastSave = Date.now();
  await Promise.all([0, 1, 2].map(async () => {
    while (work.length && left() > 4 * 60e3) {
      const s = work.shift();
      const r = await yahoo(s, FROM, TO);
      if (r) out[s] = r; else if (left() > 60e3) tries[s] = (tries[s] || 0) + 1;
      if (++n % 100 === 0) console.log('stocks', n, 'of', syms.length, 'left', work.length, '429s', n429);
      if (Date.now() - lastSave > 5 * 60e3) { lastSave = Date.now(); save(false); }
      await sleep(300);
    }
  }));
  save(true);
}
fs.writeFileSync('data/hist/meta_long.json', JSON.stringify({ built: new Date().toISOString() }, null, 2) + '\n');
