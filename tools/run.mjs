// Runs the engine over everything collected so far and writes what the page shows (data/state.json), the list of
// stocks held for the next intraday run (data/held.json) and a short summary. The live account is kept as a book
// (data/book.json): a day goes in once its closing prices are final and later runs continue from it, so fills that
// happened never change. Once a day is in the book the evolution lab runs for that evening (data/evolution.json).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../engine.js');
const Lab = require('../evolve.js');
const Bonds = require('../bonds.js');
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
const D = E.prepare(seed, L, intra, bondsHist ? { instruments: (dates) => Bonds.build(bondsHist, L.days, dates) } : null);
const T = D.dates.length;
// days whose closing prices are final go into the book
const adv = warm || book ? E.advanceBook(D, { book, warm, capital, liveStart, btStart: settings.btStart }) : { book: null, added: [] };
book = adv.book;
let bookChanged = adv.added.length > 0;
// the evolution lab, once for each evening (a failure is noted once for that day and does not stop the account)
let evo = readJSON('data/evolution.json', null), evoChanged = false, labMs = null, promoted = null;
if (book && (!evo || !evo.lastRun || evo.lastRun < book.date) && !(evo && evo.lastError && evo.lastError.date === book.date)) {
  const t1 = Date.now();
  try {
    const r = Lab.night(E, D, book, evo);
    if (r.changed) { evo = r.evo; evoChanged = true; }
    if (r.book !== book) { book = r.book; bookChanged = true; promoted = r.promoted; }
  } catch (e) {
    evo = Object.assign({ v: 1, gen: 0, since: book.from0, seq: 0, shadows: [], history: [], lastRun: null, lastScreen: null }, evo || {},
      { lastError: { date: book.date, at: new Date().toISOString(), msg: String((e && e.stack) || e).slice(0, 800) } });
    evoChanged = true;
  }
  labMs = Date.now() - t1;
}
if (bookChanged) fs.writeFileSync('data/book.json', JSON.stringify(book));
if (evoChanged) fs.writeFileSync('data/evolution.json', JSON.stringify(evo));
// what the page shows: the book, plus today while the market is open
const lv = book ? E.simulate(D, { resume: book, to: T - 1, adaptive: true, log: true }) : null;
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
  const daily = [];
  if (li >= 0) for (let t = li; t < T; t++) {
    const ix = (byDate.get(D.dates[t]) || {}).ix || {};
    daily.push({ date: D.dates[t], spx: r2(D.spx[t]), ndx: r2(ix.ndx), dji: r2(ix.dji) });
  }
  const doc = intra[D.dates[T - 1]];
  const intraday = doc && Array.isArray(doc.snaps) ? doc.snaps.map((s) => ({ t: s.t, spx: r2(s.spx), ndx: r2(s.ix && s.ix.ndx), dji: r2(s.ix && s.ix.dji) })).sort((a, b) => (a.t < b.t ? -1 : 1)) : [];
  return { names: { spx: 'S&P 500', ndx: '나스닥 100', dji: '다우존스' }, daily, intraday, prev: (doc && doc.prev) || null };
}
// fills: every buy and sell, newest first (a trade still open has only its buy)
const orders = [];
if (lv) {
  for (const t of lv.trades) {
    orders.push({ side: 'buy', id: t.id, date: t.entryDate, time: t.et || null, sym: t.sym, name: t.name, pb: t.pb, qty: t.qty, price: t.entry, fee: t.feeBuy || 0 });
    orders.push({ side: 'sell', id: t.id, date: t.exitDate, time: t.xt || null, sym: t.sym, name: t.name, pb: t.pb, qty: t.qty, price: t.exit, entry: t.entry,
      fee: t.feeSell ? t.feeSell.total : 0, feeDetail: t.feeSell || null, pnl: t.pnl, pct: t.pct, R: t.R, reason: t.reason, days: t.days });
  }
  for (const p of lv.open) orders.push({ side: 'buy', id: p.id, date: p.entryDate, time: p.et || null, sym: p.sym, name: p.name, pb: p.pb, qty: p.qty, price: p.entry, fee: p.feeBuy || 0, open: true });
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
const state = {
  v: 2, built: new Date().toISOString(),
  asOf: { date: res.D.last, time: res.D.lastTime, prov: !!res.D.prov },
  regime: res.regime, gate: res.gate, capital: res.capital, liveStart: res.liveStart,
  account: lv ? { equity: lv.equity, intraday: lv.intraday, open: lv.open, stats: fin(lv.stats), mults: lv.mults, dtPaused: lv.dtPaused, risk: lv.risk,
    hedge: lv.hedge, hedgeFees: Math.round((lv.hedgeFills || []).reduce((a, h) => a + (h.fee || 0), 0) * 100) / 100, lockedThrough: book ? book.date : null,
    marginPaid: lv.marginPaid || 0, lev: lv.lev || 1 } : null,
  teams: lv ? teamsView(lv) : null,
  evolution: Lab.view(E, evo),
  compare: compareView(),
  orders, daily, byPb,
  data: { liveBuilt: live.built || null, sources: readJSON('data/source.json', null) },
};
fs.writeFileSync('data/state.json', JSON.stringify(state));
fs.writeFileSync('data/held.json', JSON.stringify({ syms: lv ? lv.open.map((p) => p.sym).sort() : [] }));
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
