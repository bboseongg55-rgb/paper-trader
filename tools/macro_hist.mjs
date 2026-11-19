// Daily history for the allocator and the futures trend strategy: volatility indexes, Russell 2000, the S&P 500 and
// Nasdaq 100, the dollar, US short and long rates (CNBC daily bars), the high-yield credit spread and the policy rate
// (FRED), and every futures market's front contract (CNBC). Writes data/macro_hist.json. Run by the workflow's nightly
// and macro-hist modes.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as S from './sources.mjs';
const require = createRequire(import.meta.url);
const Dv = require('../deriv.js');

const from = '20240101000000', now = new Date();
const to = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}235959`;
const CNBC = ['.SPX', '.NDX', '.RUT', '.VIX', '.VXN', '.DXY', 'US1M', 'US3M', 'US2Y', 'US10Y', ...Dv.FUT.map((f) => f.cnbc + '.1')];
const FRED = ['BAMLH0A0HYM2', 'DFF'];
const out = { built: now.toISOString(), asOf: null, s: {}, errors: {} };
const iso = (tt) => `${tt.slice(0, 4)}-${tt.slice(4, 6)}-${tt.slice(6, 8)}`;
for (const sym of CNBC) {
  try {
    const j = JSON.parse(await S.getText(`https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${from}/${to}/adjusted/EST5EDT.json`, { timeout: 20000, tries: 2 }));
    const m = {};
    for (const b of (j.barData && j.barData.priceBars) || []) { const v = parseFloat(b.close); if (Number.isFinite(v) && v > 0 && b.tradeTime) m[iso(String(b.tradeTime))] = v; }
    if (Object.keys(m).length) out.s[sym] = m; else out.errors[sym] = 'no bars';
  } catch (e) { out.errors[sym] = String(e.message || e).slice(0, 160); }
}
for (const id of FRED) {
  try {
    const t = await S.getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { timeout: 20000, tries: 2 });
    const m = {};
    for (const line of t.trim().split(/\r?\n/).slice(1)) { const [d, v] = line.split(','); const x = parseFloat(v); if (d >= '2024-01-01' && Number.isFinite(x)) m[d] = x; }
    if (Object.keys(m).length) out.s['fred:' + id] = m; else out.errors['fred:' + id] = 'no rows';
  } catch (e) { out.errors['fred:' + id] = String(e.message || e).slice(0, 160); }
}
const lasts = ['.SPX', '.VIX', 'US2Y'].map((k) => out.s[k] && Object.keys(out.s[k]).sort().pop()).filter(Boolean).sort();
out.asOf = lasts[0] || null;
if (!out.s['.SPX']) { console.log(JSON.stringify({ ok: false, errors: out.errors })); process.exit(1); }
fs.writeFileSync('data/macro_hist.json', JSON.stringify(out));
console.log(JSON.stringify({ ok: true, asOf: out.asOf, series: Object.keys(out.s).length, errors: out.errors }));
