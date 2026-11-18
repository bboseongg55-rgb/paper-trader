// The crypto account's loop, run by .github/workflows/crypto.yml around the clock (one job of up to about 6 hours,
// the hourly schedule starts the next). About every 15 seconds it reads the best bid and ask for BTC, ETH and SOL at five
// US exchanges (public order-book endpoints, no keys), runs crypto.js, and every 2 minutes saves what the page shows
// (data/crypto/view.json) and pushes it; the full state (data/crypto/state.json) is saved every 10 minutes and at the end.
// Money comes from the main account through data/alloc.json (written by tools/run.mjs).
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as S from './sources.mjs';
const require = createRequire(import.meta.url);
const C = require('../crypto.js');

const MINUTES = +(process.env.MINUTES || 340), TICK = 15e3, SAVE_VIEW = 120e3, SAVE_STATE = 600e3, PULL = 300e3;
const END = Date.now() + MINUTES * 60e3;
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
fs.mkdirSync('data/crypto', { recursive: true });
const getJ = async (url) => JSON.parse(await S.getText(url, { timeout: 6000, tries: 1 }));
const n = (v) => { const x = +v; return Number.isFinite(x) ? x : NaN; };
const COINS = C.COINS;

// best bid and ask (with sizes where the exchange gives them) for each coin at each exchange
const FETCH = {
  coinbase: async () => { const o = {}; await Promise.all(COINS.map(async (c) => { const j = await getJ(`https://api.exchange.coinbase.com/products/${c}-USD/book?level=1`); const b = j.bids && j.bids[0], a = j.asks && j.asks[0]; if (b && a) o[c] = { bid: n(b[0]), bidSz: n(b[1]), ask: n(a[0]), askSz: n(a[1]) }; })); return o; },
  kraken: async () => {
    const j = await getJ('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD'), map = { XXBTZUSD: 'BTC', XBTUSD: 'BTC', XETHZUSD: 'ETH', ETHUSD: 'ETH', SOLUSD: 'SOL' }, o = {};
    for (const [k, r] of Object.entries(j.result || {})) { const c = map[k]; if (c && r.a && r.b) o[c] = { bid: n(r.b[0]), bidSz: n(r.b[2]), ask: n(r.a[0]), askSz: n(r.a[2]) }; }
    return o;
  },
  bitstamp: async () => { const o = {}; await Promise.all(COINS.map(async (c) => { const j = await getJ(`https://www.bitstamp.net/api/v2/ticker/${c.toLowerCase()}usd/`); o[c] = { bid: n(j.bid), ask: n(j.ask), bidSz: NaN, askSz: NaN }; })); return o; },
  gemini: async () => { const o = {}; await Promise.all(COINS.map(async (c) => { const j = await getJ(`https://api.gemini.com/v1/book/${c.toLowerCase()}usd?limit_bids=1&limit_asks=1`); const b = j.bids && j.bids[0], a = j.asks && j.asks[0]; if (b && a) o[c] = { bid: n(b.price), bidSz: n(b.amount), ask: n(a.price), askSz: n(a.amount) }; })); return o; },
  binanceus: async () => { const o = {}; await Promise.all(COINS.map(async (c) => { const j = await getJ(`https://api.binance.us/api/v3/ticker/bookTicker?symbol=${c}USD`); o[c] = { bid: n(j.bidPrice), bidSz: n(j.bidQty), ask: n(j.askPrice), askSz: n(j.askQty) }; })); return o; },
};
const errs = {};
async function poll() {
  const books = {}, t0 = Date.now();
  await Promise.all(Object.entries(FETCH).map(async ([k, f]) => {
    try {
      const o = await f();
      const ok = Object.fromEntries(Object.entries(o).filter(([, v]) => v.bid > 0 && v.ask > 0 && v.ask >= v.bid));
      if (Object.keys(ok).length) books[k] = ok;
    } catch (e) { errs[k] = (errs[k] || 0) + 1; }
  }));
  return { at: Date.now(), ms: Date.now() - t0, books };
}
// hourly and minute candles from Coinbase, so the strategies start with history
async function seedBars(st) {
  for (const c of COINS) {
    for (const [kind, g] of [['h', 3600], ['m', 60]]) {
      if ((st.bars[kind][c] || []).length >= (kind === 'h' ? 120 : 40)) continue;
      try { const j = await getJ(`https://api.exchange.coinbase.com/products/${c}-USD/candles?granularity=${g}`); C.seed(st, c, kind, j.map((r) => [r[0] * 1000, r[3], r[2], r[1], r[4]]).filter((r) => r[0] < Math.floor(Date.now() / (g * 1000)) * g * 1000)); }
      catch (e) { console.log('seed failed', c, kind, String(e.message || e).slice(0, 120)); }
    }
  }
}
const sh = (cmd) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); } catch (e) { return 'ERR ' + String(e.stderr || e.message || e).slice(0, 200); } };
const pull = () => sh('git pull -q --rebase -X theirs || git rebase --abort');
const save = (full) => {
  if (st) {
    fs.writeFileSync('data/crypto/view.json', JSON.stringify(C.view(st)));
    if (full) fs.writeFileSync('data/crypto/state.json', JSON.stringify(st));
  }
  return sh('bash tools/save.sh crypto');
};

let st = readJSON('data/crypto/state.json', null);
let lastView = 0, lastState = Date.now(), lastPull = 0, ticks = 0;
sh('git config user.name "paper-trader-bot"');
sh('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
console.log('crypto loop start', new Date().toISOString(), st ? `equity ${st.eq}` : 'no account yet');
while (Date.now() < END) {
  const now = Date.now();
  if (now - lastPull >= PULL) { pull(); lastPull = now; }
  const q = await poll();
  if (Object.keys(q.books).length >= 3) {
    // money from the main account (each transfer once; the main account has already taken it out)
    const alloc = readJSON('data/alloc.json', null);
    for (const tr of (alloc && alloc.transfers) || []) {
      if (!tr.stockDone || tr.to !== 'crypto' && tr.from !== 'crypto') continue;
      if (st && (st.transfers || []).some((x) => x.id === tr.id)) continue;
      const amt = tr.to === 'crypto' ? tr.amount : -tr.amount;
      if (!st) { st = C.init(0, q, q.at); await seedBars(st); }
      C.fund(st, amt, q, q.at, tr.id);
      console.log('funded', tr.id, amt);
      lastView = 0;
    }
    if (st) { C.step(st, q, q.at); ticks++; }
  }
  if (st && Date.now() - lastView >= SAVE_VIEW) {
    const full = Date.now() - lastState >= SAVE_STATE;
    const r = save(full);
    if (full) lastState = Date.now();
    lastView = Date.now();
    console.log(new Date().toISOString().slice(11, 19), `eq ${st.eq}`, `ticks ${ticks}`, `venues ${Object.keys(q.books).join(',')}`, `poll ${q.ms}ms`, `fills ${st.fills.length}`, r.split('\n').pop(), Object.keys(errs).length ? 'errors ' + JSON.stringify(errs) : '');
  }
  const wait = TICK - (Date.now() % TICK);
  await new Promise((r) => setTimeout(r, Math.max(1000, wait)));
}
console.log('crypto loop end', save(true));
