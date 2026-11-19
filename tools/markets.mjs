// Live quotes for the derivatives part and the allocator, saved to data/markets.json: every futures market's front
// and next contract (contract month, expiry, settlement), the VIX family, stock indexes, the dollar and US rates
// (CNBC, one call); and the SPY option chain from CBOE (delayed quotes, puts 7 to 90 days out, compacted) when the
// account holds options or the allocator allows them, at most every 15 minutes. Run before tools/run.mjs.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as S from './sources.mjs';
const require = createRequire(import.meta.url);
const Dv = require('../deriv.js');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const num = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(x) ? x : null; };
const isoDate = (v) => { const s = String(v || ''); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const prev = readJSON('data/markets.json', {});
const out = { at: Date.now(), fut: {}, ix: {}, errors: {}, chain: prev.chain || null };
const t0 = Date.now();

// 1. CNBC: futures (front and next), indexes, rates
const IX = ['.SPX', '.NDX', '.RUT', '.VIX', '.VXN', '.DXY', 'US1M', 'US3M', 'US2Y', 'US10Y'];
const syms = [...Dv.FUT.flatMap((f) => [f.cnbc + '.1', f.cnbc + '.2']), ...IX];
try {
  const raw = [];
  for (let i = 0; i < syms.length; i += 40) {
    const b = syms.slice(i, i + 40);
    const j = JSON.parse(await S.getText(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${b.map(encodeURIComponent).join('%7C')}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`, { timeout: 20000, tries: 2 }));
    let q = j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote; if (q && !Array.isArray(q)) q = [q];
    raw.push(...(q || []));
  }
  const by = new Map(raw.map((x) => [x.symbol, x]));
  for (const f of Dv.FUT) {
    const one = (x) => {
      if (!x) return null;
      const px = num(x.last), m = /\(([A-Za-z]{3}'\d{2})\)/.exec(x.name || '');
      return px > 0 ? { px, prev: num(x.previous_day_closing), contract: m ? m[1] : null, exp: isoDate(x.expiration_date), settle: num(x.settlePrice), settleDate: isoDate(x.settleDate), oi: num(x.open_interest), time: x.last_time || null, name: x.name || null } : null;
    };
    const c1 = one(by.get(f.cnbc + '.1')), c2 = one(by.get(f.cnbc + '.2'));
    if (c1) out.fut[f.key] = { c1, c2 };
  }
  for (const s of IX) { const x = by.get(s); const px = x && num(x.last); if (px > 0) out.ix[s] = { px, prev: num(x.previous_day_closing), time: x.last_time || null }; }
} catch (e) { out.errors.cnbc = String(e.message || e).slice(0, 200); }

// 2. the SPY option chain, only when needed
const dv = readJSON('data/deriv/state.json', null), al = readJSON('data/alloc.json', null);
const cio = al && al.cio && al.cio.opt;
const need = (dv && dv.opt && dv.opt.length) || (cio && (cio.credit || cio.hedge)) || process.argv.includes('--chain');
const old = out.chain && out.chain.SPY;
if (need && (!old || Date.now() - old.at >= 14 * 60e3 || process.argv.includes('--chain'))) {
  try {
    const j = JSON.parse(await S.getText('https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json', { timeout: 40000, tries: 2 }));
    const spot = num(j.data && j.data.current_price), today = new Date().toISOString().slice(0, 10), exps = {};
    const held = new Set(((dv && dv.opt) || []).map((o) => o.exp));
    for (const o of (j.data && j.data.options) || []) {
      const m = /^SPY(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(o.option);
      if (!m || m[4] !== 'P') continue;
      const exp = `20${m[1]}-${m[2]}-${m[3]}`, K = +m[5] / 1000, dte = (Date.parse(exp) - Date.parse(today)) / 864e5;
      if (!held.has(exp) && (dte < 7 || dte > 90)) continue;
      if (!(spot > 0) || K < spot * 0.7 || K > spot * 1.05) continue;
      (exps[exp] = exps[exp] || { puts: [] }).puts.push([K, num(o.bid), num(o.ask), num(o.iv), num(o.delta)]);
    }
    for (const e in exps) exps[e].puts.sort((a, b) => a[0] - b[0]);
    if (spot > 0 && Object.keys(exps).length) out.chain = Object.assign({}, out.chain || {}, { SPY: { at: Date.now(), quoteTime: j.timestamp || null, spot, exps } });
  } catch (e) { out.errors.cboe = String(e.message || e).slice(0, 200); }
}
fs.writeFileSync('data/markets.json', JSON.stringify(out));
console.log(JSON.stringify({ ok: !out.errors.cnbc, ms: Date.now() - t0, fut: Object.keys(out.fut).length, ix: Object.keys(out.ix).length, chain: out.chain && out.chain.SPY ? { at: new Date(out.chain.SPY.at).toISOString(), exps: Object.keys(out.chain.SPY.exps).length } : null, errors: out.errors }));
