// Runs the engine over everything collected so far and writes what the page shows (data/state.json, not committed),
// the list of stocks held for the next intraday run (data/held.json) and a short summary kept in the repository.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../engine.js');
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
const res = E.runAll(seed, Object.assign({}, live, { days }), settings, intra);
const fin = (st) => Object.fromEntries(Object.entries(st || {}).map(([k, v]) => [k, typeof v === 'number' && !Number.isFinite(v) ? null : v]));
const lv = res.live;
// fills: every buy and sell, newest first (a trade still open has only its buy)
const orders = [];
if (lv) {
  for (const t of lv.trades) {
    orders.push({ side: 'buy', id: t.id, date: t.entryDate, time: t.et || null, sym: t.sym, name: t.name, pb: t.pb, qty: t.qty, price: t.entry, fee: t.feeBuy || 0 });
    orders.push({ side: 'sell', id: t.id, date: t.exitDate, time: t.xt || null, sym: t.sym, name: t.name, pb: t.pb, qty: t.qty, price: t.exit, entry: t.entry,
      fee: t.feeSell ? t.feeSell.total : 0, feeDetail: t.feeSell || null, pnl: t.pnl, pct: t.pct, R: t.R, reason: t.reason, days: t.days });
  }
  for (const p of lv.open) orders.push({ side: 'buy', id: p.id, date: p.entryDate, time: p.et || null, sym: p.sym, name: p.name, pb: p.pb, qty: p.qty, price: p.entry, fee: p.feeBuy || 0, open: true });
  const key = (o) => `${o.date} ${o.time || '16:00'} ${o.side === 'sell' ? 1 : 0} ${String(o.id).padStart(6, '0')}`;
  orders.sort((a, b) => (key(a) < key(b) ? 1 : -1));
}
// profit by day
const daily = [];
if (lv) lv.equity.forEach((e, k) => {
  const prev = k ? lv.equity[k - 1] : { eq: res.capital, bench: res.capital };
  daily.push({ date: e.date, time: e.time || null, prov: !!e.prov, eq: e.eq, pnl: Math.round((e.eq - prev.eq) * 100) / 100, pct: e.eq / prev.eq - 1, bench: e.bench / prev.bench - 1 });
});
// by playbook
const byPb = {};
if (lv) for (const t of lv.trades) {
  const b = (byPb[t.pb] = byPb[t.pb] || { n: 0, wins: 0, pnl: 0, fees: 0 });
  b.n++; if (t.pnl > 0) b.wins++; b.pnl = Math.round((b.pnl + t.pnl) * 100) / 100; b.fees = Math.round((b.fees + (t.fee || 0)) * 100) / 100;
}
const state = {
  v: 2, built: new Date().toISOString(),
  asOf: { date: res.D.last, time: res.D.lastTime, prov: !!res.D.prov },
  regime: res.regime, gate: res.gate, capital: res.capital, liveStart: res.liveStart,
  account: lv ? { equity: lv.equity, intraday: lv.intraday, open: lv.open, stats: fin(lv.stats), mults: lv.mults, dtPaused: lv.dtPaused, risk: lv.risk } : null,
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
  signals: ((lv ? lv.signals : res.bt.signals) || []).slice(0, 10).map((s) => ({ sym: s.sym, pb: s.pb, taken: s.taken, why: s.why })),
};
fs.writeFileSync('data/summary.json', JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ok: true, ms: Date.now() - t0, asOf: state.asOf, equity: last ? last.eq : null, open: lv ? lv.open.length : 0, bytes: fs.statSync('data/state.json').size }));
