// Runs the combined account and writes what the page shows (data/state.json), the list of stocks held for the next
// intraday run (data/held.json) and a short summary. The account has three parts that share one balance:
// - stocks, bonds and the hedge (engine.js), kept as a book (data/book.json): a day goes in once its closing prices are
//   final and later runs continue from it, so fills that happened never change; the evolution lab runs each evening;
// - futures, options and ELS (deriv.js, data/deriv/state.json): settled once per closed day, managed during the session;
// - coins and tokenized stocks around the clock (crypto.js, run by tools/crypto_loop.mjs, data/crypto/view.json).
// Once per closed day the allocator (cio.js) reads the market, sets each part's budget and moves money between the parts
// (data/alloc.json). Idle cash earns the RP rate.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../engine.js');
const Lab = require('../evolve.js');
const Bonds = require('../bonds.js');
const Dv = require('../deriv.js');
const CIO = require('../cio.js');
const IXL = require('../indexes.js').LIST;
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const t0 = Date.now();
const seed = readJSON('data/seed.json');
const live = readJSON('data/live.json', { meta: {}, days: [] });
const settings = readJSON('data/settings.json', {});
const today = readJSON('data/today.json', null);
const days = (live.days || []).slice();
if (today && today.date && !days.some((d) => d.date === today.date) && (!days.length || today.date > days[days.length - 1].date)) days.push(today);
const intra = {};
if (fs.existsSync('data/intraday')) for (const f of fs.readdirSync('data/intraday')) {
  const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
  if (m && m[1] >= (settings.liveStart || '')) intra[m[1]] = readJSON(`data/intraday/${f}`, null);
}
const L = Object.assign({}, live, { days });
const capital = settings.capital || 100000, liveStart = settings.liveStart || '2026-11-17';
// the live account's starting state, saved once (data/warm.json) from what the past test learned
let warm = readJSON('data/warm.json', null);
let book = readJSON('data/book.json', null);
if (!book && !warm) {
  const r0 = E.runAll(seed, L, settings, intra);
  if (r0.start) { warm = Object.assign({ saved: new Date().toISOString().slice(0, 10) }, r0.start); fs.writeFileSync('data/warm.json', JSON.stringify(warm)); }
}
// bonds: each country's government bond (from its yield and currency) and bond ETFs, on the same trading days
const bondsHist = readJSON('data/bonds_hist.json', null);
// the market picture and futures history (data/macro_hist.json), and live futures, indexes and options (data/markets.json)
const macro = readJSON('data/macro_hist.json', null), MS = (macro && macro.s) || {};
const mk = readJSON('data/markets.json', null) || {};
// today's closing values from the live quotes, where the daily history has not caught up yet
for (const [sym, q] of Object.entries(mk.ix || {})) { const d = q && q.time && q.time.slice(0, 10); if (d && q.px > 0) { MS[sym] = MS[sym] || {}; if (MS[sym][d] == null) MS[sym][d] = q.px; } }
for (const f of Dv.FUT) { const c = mk.fut && mk.fut[f.key] && mk.fut[f.key].c1, k = f.cnbc + '.1'; if (c && c.settle > 0 && c.settleDate) { MS[k] = MS[k] || {}; if (MS[k][c.settleDate] == null) MS[k][c.settleDate] = c.settle; } }
// the allocator's ledger: its last decision, the stock engine's tilts by day, and money moved between the parts
const allocRaw = readJSON('data/alloc.json', null);
let alloc = !allocRaw ? { v: 2, cio: null, tilts: [], transfers: [], history: [] }
  : allocRaw.v === 2 ? allocRaw : { v: 2, cio: null, tilts: [], transfers: (allocRaw.transfers || []).map((t) => Object.assign({ from: 'core' }, t)), history: [], first: { why: allocRaw.why, target: allocRaw.target } };
let allocChanged = !allocRaw || allocRaw.v !== 2;
const tiltAt = (date) => { let t = null; for (const x of alloc.tilts) { if (x.from < date) t = x.core; else break; } return t; };
// RP rate for each trading day: the 1-month T-bill yield less 0.25%p
const rpFor = (dates) => {
  const y = MS.US1M || {}, ks = Object.keys(y).sort();
  let j = 0, last = null;
  return dates.map((d) => { while (j < ks.length && ks[j] <= d) last = y[ks[j++]]; return last == null ? null : Math.max(0, last - Dv.CFG.rpSpread * 100) / 100; });
};
const D = E.prepare(seed, L, intra, { instruments: bondsHist ? (dates) => Bonds.build(bondsHist, L.days, dates) : null, rp: rpFor });
const T = D.dates.length;
// days whose closing prices are final go into the book
const adv = warm || book ? E.advanceBook(D, { book, warm, capital, liveStart, btStart: settings.btStart, tilt: tiltAt }) : { book: null, added: [] };
book = adv.book;
let bookChanged = adv.added.length > 0;
// the evolution lab, once for each evening (a failure is noted once for that day and does not stop the account)
let evo = readJSON('data/evolution.json', null), evoChanged = false, labMs = null, promoted = null;
if (book && (!evo || !evo.lastRun || evo.lastRun < book.date) && !(evo && evo.lastError && evo.lastError.date === book.date)) {
  const t1 = Date.now();
  try {
    const r = Lab.night(E, D, book, evo, { tilt: tiltAt });
    if (r.changed) { evo = r.evo; evoChanged = true; }
    if (r.book !== book) { book = r.book; bookChanged = true; promoted = r.promoted; }
  } catch (e) {
    evo = Object.assign({ v: 1, gen: 0, since: book.from0, seq: 0, shadows: [], history: [], lastRun: null, lastScreen: null }, evo || {},
      { lastError: { date: book.date, at: new Date().toISOString(), msg: String((e && e.stack) || e).slice(0, 800) } });
    evoChanged = true;
  }
  labMs = Date.now() - t1;
}
// ── the allocator and the other two parts of the account
const r2 = (v) => Math.round(v * 100) / 100;
const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const cv = readJSON('data/crypto/view.json', null);
let dst = readJSON('data/deriv/state.json', null), derivChanged = false;
const moveCore = (amount, id, other) => {          // money into (+) or out of (−) the stock book, after its last close
  book = JSON.parse(JSON.stringify(book));
  book.state.cash += amount; book.state.peak += amount; book.state.prevEq += amount;
  book.flows = (book.flows || []).concat([amount < 0 ? { id, date: book.date, amount: r2(amount), to: other } : { id, date: book.date, amount: r2(amount), from: other }]);
  bookChanged = true;
};
// money the 24-hour part has sent out: the book takes it in now
for (const tr of alloc.transfers) {
  if (tr.from === 'crypto' && !tr.stockDone && book && cv && (cv.transfers || []).some((x) => x.id === tr.id)) { moveCore(tr.amount, tr.id, 'crypto'); tr.stockDone = true; tr.doneAt = new Date().toISOString(); allocChanged = true; }
}
const coreNow = () => { const e = book.hist.equity, l = e[e.length - 1]; return l.eq + (book.flows || []).filter((f) => f.date >= l.date).reduce((a, f) => a + f.amount, 0); };
const cryptoSeen = new Set(((cv && cv.transfers) || []).map((x) => x.id));
const transit = () => alloc.transfers.reduce((a, t) => a + (t.to === 'crypto' && t.stockDone && !cryptoSeen.has(t.id) ? t.amount : t.from === 'crypto' && !t.stockDone && cryptoSeen.has(t.id) ? t.amount : 0), 0);
const valAt = (sym, d) => { const m = MS[sym] || {}; if (m[d] != null) return m[d]; const q = (mk.ix || {})[sym]; if (q && q.time && q.time.slice(0, 10) === d) return q.px; const ks = Object.keys(m).filter((k) => k <= d).sort(); return ks.length ? m[ks[ks.length - 1]] : null; };
let decided = false;
if (book && MS['.SPX'] && (!alloc.cio || alloc.cio.date < book.date || alloc.cio.v !== CIO.V)) {
  const pic = CIO.picture(MS, book.date);
  // what the allocator needs to know about the account: the stocks it would protect, and today's ELS coupon
  const expo = book.state.positions.filter((p) => p.pb !== 'bd').reduce((a, p) => a + p.qty * (p.lastPx || p.fill || 0), 0)
    + (dst ? Object.values(dst.fut).filter((p) => (p.g === 'eq' || p.g === 'sc') && p.qty > 0).reduce((a, p) => a + p.qty * p.px * p.mult, 0) : 0)
    + (((cv && cv.toks) || []).reduce((a, t) => a + (t.value || 0), 0));
  let elsCoupon = null;
  if (pic.vix > 0) {
    const E2 = Dv.CFG.els, obs = E2.obs.map((b, i) => [0.5 * (i + 1), b]);
    const v = Dv.elsValue({ perf: [1, 1], t0: 0, obs, ki: E2.ki, kiHit: false, T: 3, paths: 3000, seed: 11, sig: [0.5 * pic.vix / 100 + 0.09, 0.5 * (pic.vxn || pic.vix * 1.3) / 100 + 0.115], rho: pic.rho || 0.9, r: (pic.y2 || 4) / 100, q: [E2.qSpx, E2.qNdx] });
    elsCoupon = (E2.fvTarget - v.A) / v.B;
  }
  // the IWM wheel: its price, the account, and what it already holds (shares and the cash a short put ties up)
  const iwm = (mk.ix && mk.ix.IWM && mk.ix.IWM.px) || (mk.chain && mk.chain.IWM && mk.chain.IWM.spot) || null;
  const acct0 = coreNow() + (dst ? Dv.equity(dst) : 0) + ((cv && cv.eq) || 0) + transit();
  const wheelHeld = dst ? Object.values(dst.stk || {}).reduce((a, x) => a + x.qty * x.px, 0) + dst.opt.filter((o) => o.side === 'csp').reduce((a, o) => a + o.n * 100 * o.k, 0) : 0;
  const dec = CIO.decide(pic, { exposure: expo, elsCoupon, iwm, account: acct0, wheelHeld });
  alloc.cio = dec; decided = true; allocChanged = true;
  alloc.history = (alloc.history || []).filter((h) => h.date !== book.date).concat([{ date: book.date, key: dec.regime.key, label: dec.regime.label, headline: dec.headline, target: dec.target }]).slice(-250);
  const lt = alloc.tilts[alloc.tilts.length - 1];
  if (!lt || JSON.stringify(lt.core) !== JSON.stringify(dec.tilt.core)) alloc.tilts.push({ from: book.date, core: dec.tilt.core });
}
// each part toward its share of the account (moves of at least 2%p of the account and $1,000)
if (decided && book) {
  const coreV = coreNow(), derivV = dst ? Dv.equity(dst) : 0, cryptoV = (cv && cv.eq) || 0, tr0 = transit();
  const total = coreV + derivV + cryptoV + tr0, T = alloc.cio.target, seq = () => 't' + (alloc.transfers.length + 1) + '-' + book.date.replace(/-/g, '');
  const gap = (v, k) => T[k] * total - v;
  // the derivatives part (same run, both sides at once)
  let g = gap(derivV, 'deriv');
  if (Math.abs(g) >= Math.max(1000, 0.02 * total)) {
    const amt = g > 0 ? Math.min(g, Math.max(0, book.state.cash - 1000)) : -Math.min(-g, Math.max(0, dst ? Dv.free(dst) - 500 : 0));
    if (Math.abs(amt) >= 1000) {
      const id = seq();
      if (!dst) dst = Dv.init(Date.now(), book.date);
      moveCore(-amt, id, 'deriv'); Dv.fund(dst, amt, Date.now(), id); dst.transfers[dst.transfers.length - 1].date = book.date; derivChanged = true;
      alloc.transfers.push({ id, at: new Date().toISOString(), date: book.date, from: amt > 0 ? 'core' : 'deriv', to: amt > 0 ? 'deriv' : 'core', amount: r2(Math.abs(amt)), stockDone: true, derivDone: true, why: alloc.cio.headline });
    }
  }
  // the 24-hour part (money in: the book pays now; money out: the 24-hour loop sends it first)
  g = gap(cryptoV + tr0, 'h24');
  const pend = alloc.transfers.some((t) => (t.to === 'crypto' && !cryptoSeen.has(t.id)) || (t.from === 'crypto' && !t.stockDone));
  if (!pend && Math.abs(g) >= Math.max(1000, 0.02 * total)) {
    const id = seq();
    if (g > 0) { const amt = Math.min(g, Math.max(0, book.state.cash - 1000)); if (amt >= 1000) { moveCore(-amt, id, 'crypto'); alloc.transfers.push({ id, at: new Date().toISOString(), date: book.date, from: 'core', to: 'crypto', amount: r2(amt), stockDone: true, why: alloc.cio.headline }); } }
    else alloc.transfers.push({ id, at: new Date().toISOString(), date: book.date, from: 'crypto', to: 'core', amount: r2(-g), stockDone: false, why: alloc.cio.headline });
  }
}
// the derivatives part: one closed day (settle, decide), or a session pass (marks, options)
if (dst && book) {
  const d = book.date, coreV = coreNow(), derivV = Dv.equity(dst), cryptoV = (cv && cv.eq) || 0, total = coreV + derivV + cryptoV + transit();
  const stocksLong = book.state.positions.filter((p) => p.pb !== 'bd').reduce((a, p) => a + p.qty * (p.lastPx || p.fill || 0), 0);
  const futLong = Object.values(dst.fut).filter((p) => (p.g === 'eq' || p.g === 'sc') && p.qty > 0).reduce((a, p) => a + p.qty * p.px * p.mult, 0);
  const toksLong = ((cv && cv.toks) || []).reduce((a, t) => a + (t.value || 0), 0);
  let rho = null;
  if (alloc.cio && alloc.cio.pic) rho = alloc.cio.pic.rho;
  const ctx = { date: d, now: Date.now(), fut: mk.fut || {}, hist: MS, chain: mk.chain || null, cio: alloc.cio ? alloc.cio.tilt : null, account: total,
    exposure: stocksLong + futLong + toksLong, spx: valAt('.SPX', d), ndx: valAt('.NDX', d), vix: valAt('.VIX', d), vxn: valAt('.VXN', d), y2: valAt('US2Y', d), rp: valAt('US1M', d), rho,
    spy: mk.chain && mk.chain.SPY ? mk.chain.SPY.spot : null, today: etToday,
    px: { SPY: (mk.ix && mk.ix.SPY && mk.ix.SPY.px) || null, IWM: (mk.ix && mk.ix.IWM && mk.ix.IWM.px) || null } };
  if (!dst.date || dst.date < d) { Dv.nightly(dst, ctx); const h = dst.hist[dst.hist.length - 1]; if (h) h.pre = r2(h.eq - (dst.transfers || []).filter((x) => x.date === d).reduce((a, x) => a + x.amount, 0)); }
  else Dv.session(dst, ctx);
  derivChanged = true;
}
if (derivChanged && dst) { fs.mkdirSync('data/deriv', { recursive: true }); fs.writeFileSync('data/deriv/state.json', JSON.stringify(dst)); }
if (allocChanged) fs.writeFileSync('data/alloc.json', JSON.stringify(alloc, null, 1));
if (bookChanged) fs.writeFileSync('data/book.json', JSON.stringify(book));
if (evoChanged) fs.writeFileSync('data/evolution.json', JSON.stringify(evo));
// what the page shows: the book, plus today while the market is open
const lv = book ? E.simulate(D, { resume: book, to: T - 1, adaptive: true, log: true, tilt: tiltAt }) : null;
const mv = E.marketView(D, lv ? lv.params : null);
const res = { D: { last: D.dates[T - 1], lastTime: D.times[T - 1] || null, prov: D.prov ? { date: D.dates[D.prov.t], time: D.prov.time } : null },
  regime: mv.regime, gate: mv.gate, capital, liveStart, live: lv };
const fin = (st) => Object.fromEntries(Object.entries(st || {}).map(([k, v]) => [k, typeof v === 'number' && !Number.isFinite(v) ? null : v]));
// index levels for the page's comparison chart: closes from the account's first day, and the last day's samples with
// the indexes' previous closes (S&P 500 from the price files; Nasdaq 100 and Dow Jones as the collector saved them)
function compareView() {
  const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const byDate = new Map(L.days.map((d) => [d.date, d]));
  const li = D.dates.findIndex((d) => d >= liveStart);
  // each day's close: the level collected at that day's close, else the market's last daily close on or before it
  const histAt = (sym, d) => { const m = MS[sym]; if (!m) return null; if (m[d] != null) return m[d]; let best = null, bd = ''; for (const k in m) if (k <= d && k > bd) { bd = k; best = m[k]; } return best; };
  const daily = [];
  if (li >= 0) for (let t = li; t < T; t++) {
    const d = D.dates[t], ix = (byDate.get(d) || {}).ix || {}, row = { date: d, spx: r2(D.spx[t]) };
    for (const x of IXL) if (x.k !== 'spx') row[x.k] = r2(ix[x.k] != null ? ix[x.k] : histAt(x.sym, d));
    daily.push(row);
  }
  const doc = intra[D.dates[T - 1]];
  const intraday = doc && Array.isArray(doc.snaps) ? doc.snaps.map((s) => { const o = { t: s.t, spx: r2(s.spx) }; for (const x of IXL) if (x.k !== 'spx') o[x.k] = r2(s.ix && s.ix[x.k]); return o; }).sort((a, b) => (a.t < b.t ? -1 : 1)) : [];
  // the close before the first day shown, for each index (the 1-day view starts there)
  const prev = Object.assign({}, (doc && doc.prev) || {});
  const pd = D.dates[T - 2];
  if (pd) for (const x of IXL) if (prev[x.k] == null) { const v = x.k === 'spx' ? D.spx[T - 2] : histAt(x.sym, pd); if (v != null) prev[x.k] = r2(v); }
  return { names: Object.fromEntries(IXL.map((x) => [x.k, x.name])), list: IXL.map((x) => ({ k: x.k, name: x.name, chip: x.chip, group: x.group })), daily, intraday, prev };
}
// fills: every buy and sell, newest first (a trade still open has only its buy)
const orders = [];
if (lv) {
  for (const t of lv.trades) {
    orders.push({ side: 'buy', id: t.id, date: t.entryDate, time: t.et || null, sym: t.sym, name: t.name, pb: t.pb, qty: t.qty, price: t.entry, fee: t.feeBuy || 0, why: t.why || null, ctx: t.ctx || null });
    orders.push({ side: 'sell', id: t.id, date: t.exitDate, time: t.xt || null, sym: t.sym, name: t.name, pb: t.pb, qty: t.qty, price: t.exit, entry: t.entry,
      fee: t.feeSell ? t.feeSell.total : 0, feeDetail: t.feeSell || null, pnl: t.pnl, pct: t.pct, R: t.R, reason: t.reason, days: t.days });
  }
  for (const p of lv.open) orders.push({ side: 'buy', id: p.id, date: p.entryDate, time: p.et || null, sym: p.sym, name: p.name, pb: p.pb, qty: p.qty, price: p.entry, fee: p.feeBuy || 0, open: true, why: p.why || null, ctx: p.ctx || null });
  (lv.hedgeFills || []).forEach((h, k) => orders.push({ side: h.side, id: 'h' + k, date: h.date, time: h.time || null, sym: 'SH', name: 'S&P 500 인버스(−1배) 헷지', pb: 'hedge',
    amount: h.amount, fee: h.fee || 0, spx: h.spx, ratio: h.ratio, why: h.why }));
  const key = (o) => `${o.date} ${o.time || '16:00'} ${o.side === 'sell' ? 1 : 0} ${String(o.id).padStart(6, '0')}`;
  orders.sort((a, b) => (key(a) < key(b) ? 1 : -1));
}
// profit by day
const daily = [];
if (lv) lv.equity.forEach((e, k) => {
  const prev = k ? lv.equity[k - 1] : { eq: res.capital, bench: res.capital };
  daily.push({ date: e.date, time: e.time || null, prov: !!e.prov, eq: e.eq, pnl: Math.round((e.eq - prev.eq) * 100) / 100, pct: e.eq / prev.eq - 1, bench: e.bench / prev.bench - 1 });
});
// by playbook (and the hedge)
const byPb = {};
if (lv) {
  const ep = lv.hedgeEpisodes || [];
  const open = lv.hedge ? lv.hedge.value + lv.hedge.got - lv.hedge.paid : 0;
  byPb.hedge = { n: ep.length, wins: ep.filter((e) => e.pnl > 0).length, pnl: Math.round((ep.reduce((a, e) => a + e.pnl, 0)) * 100) / 100, open: Math.round(open * 100) / 100 };
}
if (lv) for (const t of lv.trades) {
  const b = (byPb[t.pb] = byPb[t.pb] || { n: 0, wins: 0, pnl: 0, fees: 0 });
  b.n++; if (t.pnl > 0) b.wins++; b.pnl = Math.round((b.pnl + t.pnl) * 100) / 100; b.fees = Math.round((b.fees + (t.fee || 0)) * 100) / 100;
}
// what each of the four teams is doing: its rules (changed ones marked), its latest corrections, and its own view
function teamsView(lv) {
  const P = lv.params, own = (team) => Object.keys(E.TEAM_OF).filter((k) => E.TEAM_OF[k] === team)
    .map((k) => ({ key: k, label: E.LABELS[k], unit: E.UNITS[k], value: P[k], start: E.DEFAULTS[k], changed: P[k] !== E.DEFAULTS[k] }));
  const logs = (team) => lv.changes.filter((c) => c.kind !== 'start' && (c.teams || []).includes(team)).slice(-8).reverse()
    .map((c) => ({ date: c.date, kind: c.kind, title: c.title, body: c.body, changes: c.changes }));
  const day = res.D.last;
  return {
    select: { name: E.TEAMS.select, rules: own('select'), log: logs('select'), watch: lv.watch || [] },
    entry: { name: E.TEAMS.entry, rules: own('entry'), log: logs('entry'), mults: lv.mults, dtPaused: lv.dtPaused,
      buysToday: lv.trades.filter((t) => t.entryDate === day).length + lv.open.filter((p) => p.entryDate === day).length },
    exit: { name: E.TEAMS.exit, rules: own('exit'), log: logs('exit'), sellsToday: lv.trades.filter((t) => t.exitDate === day).length,
      watching: lv.open.length, nearest: lv.open.length ? lv.open.map((p) => ({ sym: p.sym, gap: p.price > 0 ? p.price / p.stop - 1 : null })).sort((a, b) => a.gap - b.gap)[0] : null },
    risk: { name: E.TEAMS.risk, rules: own('risk'), log: logs('risk'), gate: res.gate, regime: res.regime, hedge: lv.hedge, risk: lv.risk },
  };
}
// a bond's own daily values (last year) go with it to the page, for its chart: a bond built from yields has no quote,
// and a bond ETF is kept as a total-return index (its distributions added), which its market price is not
const withHist = (p) => {
  if (p.kind !== 'bond') return p;
  const x = D.S.find((y) => y.s === p.sym);
  if (!x) return p;
  const hist = [];
  for (let t = Math.max(0, D.dates.length - 260); t < D.dates.length; t++) if (Number.isFinite(x.c[t])) hist.push([D.dates[t], Math.round(x.c[t] * 1e4) / 1e4]);
  return Object.assign({}, p, { hist });
};
const state = {
  v: 2, built: new Date().toISOString(),
  asOf: { date: res.D.last, time: res.D.lastTime, prov: !!res.D.prov },
  regime: res.regime, gate: res.gate, capital: res.capital, liveStart: res.liveStart,
  account: lv ? { equity: lv.equity, intraday: lv.intraday, open: lv.open.map(withHist), stats: fin(lv.stats), mults: lv.mults, dtPaused: lv.dtPaused, risk: lv.risk,
    hedge: lv.hedge, hedgeFees: Math.round((lv.hedgeFills || []).reduce((a, h) => a + (h.fee || 0), 0) * 100) / 100, lockedThrough: book ? book.date : null,
    marginPaid: lv.marginPaid || 0, rpGot: lv.rpGot || 0, lev: lv.lev || 1, flows: (book && book.flows) || [],
    // money moved out after the last row (the row is before the move): the stock account's value now
    flowsAfter: Math.round(((book && book.flows) || []).filter((f) => lv.equity.length && f.date >= lv.equity[lv.equity.length - 1].date).reduce((a, f) => a + f.amount, 0) * 100) / 100 } : null,
  alloc: { cio: alloc.cio ? Object.assign({}, alloc.cio, { pic: undefined }) : null, transfers: alloc.transfers.slice(-40), history: (alloc.history || []).slice(-60), first: alloc.first || null },
  deriv: dst ? Dv.view(dst) : null,
  rates: { rp: (() => { const r = rpFor([res.D.last])[0]; return r == null ? null : Math.round(r * 1e5) / 1e5; })(), y1m: valAt('US1M', res.D.last) },
  macro: lv ? E.macroView(D, lv) : null,
  teams: lv ? teamsView(lv) : null,
  evolution: Lab.view(E, evo),
  compare: compareView(),
  orders, daily, byPb,
  data: { liveBuilt: live.built || null, sources: readJSON('data/source.json', null) },
};
fs.writeFileSync('data/state.json', JSON.stringify(state));
// the stocks held, for the next intraday quotes (bonds are not quoted: under their names CNBC gives the yield)
fs.writeFileSync('data/held.json', JSON.stringify({ syms: lv ? lv.open.filter((p) => p.kind !== 'bond').map((p) => p.sym).sort() : [] }));
// the earlier summary kept in the repository
const last = lv && lv.equity[lv.equity.length - 1];
const summary = {
  built: state.built, asOf: state.asOf, regime: res.regime.text,
  account: lv ? { equity: last, ret: state.account.stats.ret, bench: state.account.stats.bench, trades: lv.trades.length, fees: state.account.stats.fees,
    open: lv.open.map((p) => ({ sym: p.sym, qty: p.qty, entry: p.entry, price: p.price, stop: p.stop, pnl: p.pnl })),
    lastTrades: lv.trades.slice(-5).map((t) => ({ sym: t.sym, exit: t.exitDate, R: t.R, pnl: t.pnl, reason: t.reason })),
    lastChanges: lv.changes.slice(-5).map((c) => ({ date: c.date, kind: c.kind, title: c.title })) } : null,
  signals: ((lv ? lv.signals : []) || []).slice(0, 10).map((s) => ({ sym: s.sym, pb: s.pb, taken: s.taken, why: s.why })),
  book: book ? book.date : null, evolution: evo ? { gen: evo.gen, shadows: evo.shadows.length, lastRun: evo.lastRun, error: evo.lastError || null } : null,
};
fs.writeFileSync('data/summary.json', JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ok: true, ms: Date.now() - t0, asOf: state.asOf, equity: last ? last.eq : null, open: lv ? lv.open.length : 0, book: book ? book.date : null, added: adv.added,
  lab: labMs == null ? null : { ms: labMs, gen: evo.gen, shadows: evo.shadows.length, promoted: promoted ? promoted.gen : null, error: evo.lastError ? evo.lastError.msg.slice(0, 120) : null }, bytes: fs.statSync('data/state.json').size }));
