// Daily history for the bond instruments: each country's government bond yield and its currency (CNBC daily bars),
// bond ETF prices (CNBC daily bars) and their distributions (Nasdaq). Writes data/bonds_hist.json. Run by the workflow's
// nightly and bonds-hist modes; the collector adds the days after it from live quotes.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as S from './sources.mjs';
const require = createRequire(import.meta.url);
const B = require('../bonds.js');

const from = '20240101000000';
const now = new Date();
const to = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}235959`;
const out = { asOf: null, built: now.toISOString(), y: {}, fx: {}, etf: {}, div: {}, errors: {} };
const iso = (tt) => `${tt.slice(0, 4)}-${tt.slice(4, 6)}-${tt.slice(6, 8)}`;
async function bars(sym) {
  const t = await S.getText(`https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${from}/${to}/adjusted/EST5EDT.json`, { timeout: 20000, tries: 2 });
  const j = JSON.parse(t), rows = (j.barData && j.barData.priceBars) || [];
  const m = {};
  for (const b of rows) { const v = parseFloat(b.close); if (Number.isFinite(v) && b.tradeTime) m[iso(String(b.tradeTime))] = v; }
  return m;
}
async function grab(kind, sym) {
  try { const m = await bars(sym); if (Object.keys(m).length) out[kind][sym] = m; else out.errors[sym] = 'no bars'; }
  catch (e) { out.errors[sym] = String(e.message || e).slice(0, 160); }
}
for (const g of B.GOV) await grab('y', g[0]);
for (const f of B.FX) await grab('fx', f);
for (const [sym] of B.ETF) {
  await grab('etf', sym);
  try {
    const j = JSON.parse(await S.getText(`https://api.nasdaq.com/api/quote/${sym}/dividends?assetclass=etf`, { headers: { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' }, timeout: 20000, tries: 2 }));
    const rows = (j.data && j.data.dividends && j.data.dividends.rows) || [];
    const list = [];
    for (const r of rows) {
      const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(r.exOrEffDate || ''), a = parseFloat(String(r.amount || '').replace(/[$,]/g, ''));
      if (m && Number.isFinite(a) && a > 0) list.push([`${m[3]}-${m[1]}-${m[2]}`, a]);
    }
    list.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    out.div[sym] = list.filter((x) => x[0] >= '2024-01-01');
    if (!rows.length) out.errors[sym + ':div'] = 'no dividend rows';
  } catch (e) { out.errors[sym + ':div'] = String(e.message || e).slice(0, 160); }
}
// the last day every series has reached (later days come from the collector's live quotes)
const lastDays = [...Object.values(out.y), ...Object.values(out.fx), ...Object.values(out.etf)].map((m) => Object.keys(m).sort().pop()).filter(Boolean).sort();
out.asOf = lastDays.length ? lastDays[0] : null;
fs.writeFileSync('data/bonds_hist.json', JSON.stringify(out));
console.log(JSON.stringify({ ok: true, asOf: out.asOf, y: Object.keys(out.y).length, fx: Object.keys(out.fx).length, etf: Object.keys(out.etf).length, div: Object.values(out.div).filter((l) => l.length).length, errors: out.errors }));
