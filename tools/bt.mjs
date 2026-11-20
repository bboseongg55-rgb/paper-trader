// Backtest of the stock and bond engine on the saved history, for comparing a change before and after. Reads data/ only,
// writes nothing. Run it in a copy of the repository:
//   node tools/bt.mjs                      default rules, from settings.btStart (2025-01-02) to the last closed day
//   node tools/bt.mjs --from 2025-06-02    another start
//   node tools/bt.mjs --params '{"stopAtr":2.5}'   rule overrides (names in engine.js DEFAULTS)
// Prints one JSON line: return, CAGR, max drawdown, Sharpe, trades, win rate, profit factor, profit by method.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../engine.js');
const Bonds = require('../bonds.js');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

const seed = readJSON('data/seed.json'), live = readJSON('data/live.json', { days: [] }), settings = readJSON('data/settings.json', {});
const intra = {};
if (fs.existsSync('data/intraday')) for (const f of fs.readdirSync('data/intraday')) { const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f); if (m) intra[m[1]] = readJSON(`data/intraday/${f}`, null); }
const bondsHist = readJSON('data/bonds_hist.json', null), macro = readJSON('data/macro_hist.json', null), MS = (macro && macro.s) || {};
const rpFor = (dates) => { const y = MS.US1M || {}, ks = Object.keys(y).sort(); let j = 0, last = null; return dates.map((d) => { while (j < ks.length && ks[j] <= d) last = y[ks[j++]]; return last == null ? null : Math.max(0, last - 0.25) / 100; }); };
const L = Object.assign({}, live, { days: (live.days || []).filter((d) => d.final !== false) });
const D = E.prepare(seed, L, intra, { instruments: bondsHist ? (dates) => Bonds.build(bondsHist, L.days, dates) : null, rp: rpFor });
const from = Math.max(0, D.dates.findIndex((d) => d >= (arg('--from') || settings.btStart || '2025-01-02')));
const toI = arg('--to') ? D.dates.findIndex((d) => d > arg('--to')) - 1 : -2;
const to = toI >= 0 ? toI : D.dates.length - 1, capital = settings.capital || 100000;
const tiltArg = JSON.parse(arg('--tilt') || 'null');   // e.g. '{"bo":0}': per-method risk multipliers, as the allocator sets them
const params = Object.assign({}, E.DEFAULTS, JSON.parse(arg('--params') || '{}'));
const t0 = Date.now();
const r = E.simulate(D, { from, to, capital, params, adaptive: true, log: false, tilt: tiltArg ? () => tiltArg : null });

const eq = r.equity.map((e) => e.eq), rets = eq.slice(1).map((v, i) => v / eq[i] - 1);
let peak = -Infinity, mdd = 0; for (const v of eq) { peak = Math.max(peak, v); mdd = Math.max(mdd, 1 - v / peak); }
const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1), sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
const years = rets.length / 252, total = eq[eq.length - 1] / capital - 1;
const pnl = r.trades.map((t) => t.pnl).filter(Number.isFinite), wins = pnl.filter((x) => x > 0), loss = pnl.filter((x) => x < 0);
const by = {}; for (const t of r.trades) { const k = t.pb || '?'; by[k] = by[k] || { n: 0, pnl: 0 }; by[k].n++; by[k].pnl = Math.round((by[k].pnl + (t.pnl || 0)) * 100) / 100; }
const rd = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
console.log(JSON.stringify({
  from: D.dates[from], to: D.dates[to], days: rets.length, end: Math.round(eq[eq.length - 1]), ret: rd(total), cagr: rd(years > 0 ? (1 + total) ** (1 / years) - 1 : 0),
  mdd: rd(mdd), sharpe: rd(sd > 0 ? mean / sd * Math.sqrt(252) : 0, 2), trades: pnl.length, win: rd(pnl.length ? wins.length / pnl.length : 0, 3),
  pf: rd(loss.length ? wins.reduce((a, b) => a + b, 0) / -loss.reduce((a, b) => a + b, 0) : 0, 2), by, ms: Date.now() - t0,
}));
