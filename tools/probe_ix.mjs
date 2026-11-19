// Checks which world indexes, gold and bitcoin CNBC serves (live quote with its time and previous close, and daily
// bars), for the page's index comparison. Writes data/probe_ix.json. Run by the workflow's probe-ix mode.
import fs from 'node:fs';
import * as S from './sources.mjs';
const SYMS = ['.SPX', '.NDX', '.DJI', '.RUT', '.KS11', '.KQ11', '.N225', '.HSI', '.SSEC', '.STOXX50E', '.GDAXI', '.FTSE', '.FCHI', '.GSPTSE', '.TWII', '.NSEI', '@GC.1', 'BTC.CM=', '@BTC.1', 'ETH.CM='];
const out = { at: new Date().toISOString(), quotes: {}, bars: {} };
try {
  const j = JSON.parse(await S.getText(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${SYMS.map(encodeURIComponent).join('%7C')}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`, { timeout: 20000, tries: 2 }));
  let q = j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote; if (q && !Array.isArray(q)) q = [q];
  for (const x of q || []) out.quotes[x.symbol] = { name: x.name, last: x.last, prev: x.previous_day_closing, time: x.last_time, cur: x.currencyCode || null, type: x.type || null };
} catch (e) { out.quoteErr = String(e.message || e).slice(0, 200); }
for (const s of SYMS) {
  try {
    const j = JSON.parse(await S.getText(`https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(s)}/1D/20261001000000/20261119235959/adjusted/EST5EDT.json`, { timeout: 20000, tries: 1 }));
    const b = (j.barData && j.barData.priceBars) || [];
    out.bars[s] = { n: b.length, first: b[0] && [b[0].tradeTime, b[0].close], last: b.length ? [b[b.length - 1].tradeTime, b[b.length - 1].close] : null };
  } catch (e) { out.bars[s] = { err: String(e.message || e).slice(0, 120) }; }
}
fs.writeFileSync('data/probe_ix.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 3000));
