// The long history for the strategy checks (owner 2026-11-26: "과거 데이터 확장", free public sources only, no keys).
// Run by .github/workflows/hist.yml (what=long). Writes into data/hist/:
//   sp500_members.json.gz  which stocks were in the S&P 500 on each date since 2009 (fja05680/sp500 on GitHub, built
//                          from the index's published changes), so a backtest only buys what was in the index then
//   long_stocks.json.gz    CNBC's daily closes (split adjusted, without dividends: the same kind as the book's own data)
//                          2009-01 → 2024-03 for every stock the book tracks and every stock that was in the S&P 500
//                          since 2009 and CNBC still serves; the checks splice them onto the book's own data at 2024-01-02
//   long_misc.json.gz      the S&P 500 index, the VIX, the bond funds the book trades, the continuous front-month futures
//                          the derivatives part trades and bitcoin and ether spot, each since 2007 → today (CNBC)
//   hl_funding.json.gz     Hyperliquid's hourly funding rates for BTC, ETH and SOL perpetuals since 2023 (real funding
//                          for the coin checks in place of one assumed rate)
// Yahoo Finance answers "too many requests" to GitHub's servers (tools/probe.mjs, 2026-11-18 and again 2026-11-26), so
// the daily bars come from CNBC (tools/probe_long.mjs: one request gives 1990 → today). Stocks that left the market are
// not on CNBC (Twitter, Xilinx, Activision, Celgene came back empty): the backtest still leans towards survivors (확인필요).
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
// when a source says "too many requests" every worker waits together, and the wait grows while it keeps saying so
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
// CNBC daily bars: {dates, c (close, split adjusted)}; tradeTime is the exchange's day as YYYYMMDD000000
const CNBC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const stamp = (d, end) => d.replace(/-/g, '') + (end ? '235959' : '000000');
async function daily(sym, from, to) {
  const j = await get(`https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${stamp(from)}/${stamp(to, true)}/adjusted/EST5EDT.json`, { headers: { 'User-Agent': CNBC_UA, Accept: 'application/json' } });
  const p = (j && j.barData && j.barData.priceBars) || [], dates = [], c = [];
  for (const b of p) { const v = parseFloat(b.close), t = String(b.tradeTime || ''); if (v > 0 && t.length >= 8) { dates.push(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`); c.push(+v.toPrecision(6)); } }
  return dates.length ? { dates, c } : null;
}
// a symbol as CNBC writes it (class shares with a dot: BRK.B)
const cnbcSym = (s) => s.replace(/-/g, '.');
const norm = (s) => String(s).trim().toUpperCase().replace(/[./]/g, '-');
fs.mkdirSync('data/hist', { recursive: true });

// 1. the index, the VIX, the bond funds, the futures and the coins' spot price (small: first, so a slow day
// still gets the futures and coin checks their record; what fails keeps an earlier run's copy)
{
  const list = ['.SPX', '.VIX', 'VCIT', 'VCSH', 'IGIB', 'EMB', 'BNDX', 'IGOV',
    '@SP.1', '@ND.1', '@DJ.1', '@TFS.1', '@TU.1', '@FV.1', '@TY.1', '@US.1', '@CL.1', '@GC.1', '@SI.1', '@HG.1', '@BTC.1', '@ETH.1', 'BTC.CM=', 'ETH.CM='];
  const out = old('long_misc') || {};
  for (const s of list) { const r = await daily(s, '2007-01-01', ymd(Date.now() + 864e5)); if (r) out[s] = Object.fromEntries(r.dates.map((d, i) => [d, r.c[i]])); console.log('misc', s, r ? r.dates.length : 'none'); await sleep(400); }
  // the bond funds' payouts (Nasdaq's dividend history, the same source tools/bonds_hist.mjs uses for 2024 on): without
  // them the funds' price drops on each monthly ex-date and a backtest reads it as a loss
  out.div = out.div || {};
  for (const s of ['VCIT', 'VCSH', 'IGIB', 'EMB', 'BNDX', 'IGOV']) {
    const j = await get(`https://api.nasdaq.com/api/quote/${s}/dividends?assetclass=etf`, { headers: { 'User-Agent': CNBC_UA, Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } });
    const rows = (j && j.data && j.data.dividends && j.data.dividends.rows) || [], list = [];
    for (const r of rows) {
      const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(r.exOrEffDate || ''), a = parseFloat(String(r.amount || '').replace(/[$,]/g, ''));
      if (m && Number.isFinite(a) && a > 0) list.push([`${m[3]}-${m[1]}-${m[2]}`, a]);
    }
    list.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    if (list.length) out.div[s] = list;
    console.log('payouts', s, list.length, list.length && list[0][0]);
    await sleep(400);
  }
  put('long_misc', Object.assign(out, { src: 'cnbc' }));
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
  const prev = old('long_stocks'), out = {}, tries = {};
  if (prev && prev.from === FROM && prev.to === TO && prev.s) {
    for (const [s, [i0, arr]] of Object.entries(prev.s)) { const dates = [], c = []; arr.forEach((v, k) => { if (v > 0) { dates.push(prev.dates[i0 + k]); c.push(v); } }); if (dates.length) out[s] = { dates, c }; }
    Object.assign(tries, prev.tries || {});
  }
  // a stock CNBC has said nothing about twice is not asked for again
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
    put('long_stocks', { src: 'cnbc', from: FROM, to: TO, dates: cal, s: pack, want: syms.length, pending, missing: syms.filter((s) => !out[s] && (tries[s] || 0) >= 2).length, tries, own: own.length });
    if (final) console.log('stocks have', Object.keys(out).length, 'pending', pending, '429s', n429);
  };
  let n = 0, lastSave = Date.now();
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (work.length && left() > 4 * 60e3) {
      const s = work.shift();
      const r = await daily(cnbcSym(s), FROM, TO);
      if (r) out[s] = r; else if (left() > 60e3) tries[s] = (tries[s] || 0) + 1;
      if (++n % 100 === 0) console.log('stocks', n, 'of', syms.length, 'left', work.length, '429s', n429);
      if (Date.now() - lastSave > 5 * 60e3) { lastSave = Date.now(); save(false); }
      await sleep(150);
    }
  }));
  save(true);
}
fs.writeFileSync('data/hist/meta_long.json', JSON.stringify({ built: new Date().toISOString() }, null, 2) + '\n');
