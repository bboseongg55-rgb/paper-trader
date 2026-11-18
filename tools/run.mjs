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
  if (m && m[1] >= (settings.liveStart || '')) intra[m[1]] = (readJSON(`data/intraday/${f}`, {}).snaps) || [];
}
const res = E.runAll(seed, Object.assign({}, live, { days }), settings, intra);
const fin = (st) => Object.fromEntries(Object.entries(st || {}).map(([k, v]) => [k, typeof v === 'number' && !Number.isFinite(v) ? null : v]));
const sim = (s) => s && { from: s.from, to: s.to, equity: s.equity, trades: s.trades, open: s.open, changes: s.changes, params: s.params, risk: s.risk, signals: s.signals, prov: s.prov, share: s.share, stats: fin(s.stats) };
const state = {
  v: 1, built: new Date().toISOString(),
  asOf: { date: res.D.last, time: res.D.lastTime, prov: !!res.D.prov },
  D: { last: res.D.last, symbols: res.D.symbols, nDates: res.D.dates.length, liveDays: res.D.liveDays },
  regime: res.regime, gate: res.gate, capital: res.capital, liveStart: res.liveStart, warm: res.warm,
  bt: sim(res.bt), live: sim(res.live),
  data: { seedBuilt: seed.built || null, liveBuilt: live.built || null, liveDays: (live.days || []).length, sources: readJSON('data/source.json', null) },
};
fs.writeFileSync('data/state.json', JSON.stringify(state));
const lv = res.live;
fs.writeFileSync('data/held.json', JSON.stringify({ syms: lv ? lv.open.map((p) => p.sym).sort() : [] }));
const last = lv && lv.equity[lv.equity.length - 1];
const summary = {
  built: state.built, asOf: state.asOf, regime: res.regime.text,
  account: lv ? { equity: last, ret: state.live.stats.ret, bench: state.live.stats.bench, trades: lv.trades.length,
    open: lv.open.map((p) => ({ sym: p.sym, qty: p.qty, entry: p.entry, price: p.price, stop: p.stop, pnl: p.pnl })),
    lastTrades: lv.trades.slice(-5).map((t) => ({ sym: t.sym, exit: t.exitDate, R: t.R, pnl: t.pnl, reason: t.reason })),
    lastChanges: lv.changes.slice(-5).map((c) => ({ date: c.date, kind: c.kind, title: c.title })) } : null,
  signals: ((lv ? lv.signals : res.bt.signals) || []).slice(0, 10).map((s) => ({ sym: s.sym, pb: s.pb, taken: s.taken, why: s.why })),
};
fs.writeFileSync('data/summary.json', JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ok: true, ms: Date.now() - t0, asOf: state.asOf, equity: last ? last.eq : null, open: lv ? lv.open.length : 0, bytes: fs.statSync('data/state.json').size }));
