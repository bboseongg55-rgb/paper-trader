// History for the strategy checks (tools/verify.mjs), run by .github/workflows/hist.yml on demand: Coinbase hourly
// candles for BTC, ETH and SOL since 2024-01-01, their 1-minute candles for the last DAYS_1M days, and Kraken's hourly
// candles for the tokenized stocks (the last 720 hours, all Kraken gives). Public endpoints, no keys. Written as gzip
// JSON rows [time ms, open, high, low, close, volume], oldest first, into data/hist/. Also the long daily record of US
// Treasury yields and the fed funds rate from FRED (since 1990), for the rates checks. WHAT=fred fetches only that.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../crypto.js');
const DAYS_1M = +(process.env.DAYS_1M || 45), FROM_1H = Date.parse(process.env.FROM_1H || '2024-01-01T00:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJ(url) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'paper-trader-hist' } });
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i === 5) throw e; await sleep(800 * (i + 1)); }
  }
}
async function coinbase(coin, gran, from, to) {
  const rows = new Map(), step = gran * 300 * 1000;
  for (let a = from; a < to; a += step) {
    const b = Math.min(to, a + step);
    const j = await getJ(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=${gran}&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`);
    for (const r of j || []) rows.set(r[0] * 1000, [r[0] * 1000, +r[3], +r[2], +r[1], +r[4], +r[5]]);
    await sleep(170);
  }
  return [...rows.values()].sort((x, y) => x[0] - y[0]);
}
const put = (name, rows) => { fs.writeFileSync(`data/hist/${name}.json.gz`, zlib.gzipSync(JSON.stringify(rows))); console.log(name, rows.length, rows.length ? new Date(rows[0][0]).toISOString() : '', rows.length ? new Date(rows[rows.length - 1][0]).toISOString() : ''); };
fs.mkdirSync('data/hist', { recursive: true });
const now = Math.floor(Date.now() / 60e3) * 60e3, WHAT = process.env.WHAT || 'all';
{
  const fred = {};
  for (const id of ['DGS3MO', 'DGS2', 'DGS5', 'DGS10', 'DGS30', 'DFF']) {
    try {
      const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=1990-01-01`, { headers: { 'User-Agent': 'paper-trader-hist' } });
      const rows = (await r.text()).trim().split('\n').slice(1).map((l) => l.split(',')).filter((x) => x[1] && x[1] !== '.' && isFinite(+x[1]));
      fred[id] = Object.fromEntries(rows.map((x) => [x[0], +x[1]]));
      console.log('fred', id, rows.length, rows[0] && rows[0][0], rows.length && rows[rows.length - 1][0]);
    } catch (e) { console.log('fred failed', id, String(e.message || e).slice(0, 100)); }
    await sleep(500);
  }
  if (Object.keys(fred).length) fs.writeFileSync('data/hist/fred_rates.json.gz', zlib.gzipSync(JSON.stringify(fred)));
}
if (WHAT !== 'fred') for (const c of C.COINS) {
  put(`cb_${c}_1h`, await coinbase(c, 3600, FROM_1H, Math.floor(now / 3600e3) * 3600e3));
  put(`cb_${c}_1m`, await coinbase(c, 60, now - DAYS_1M * 864e5, now));
}
const tok = {};
if (WHAT !== 'fred') for (const k of Object.keys(C.TOKS)) {
  try {
    const j = await getJ(`https://api.kraken.com/0/public/OHLC?pair=${k}USD&interval=60&asset_class=tokenized_asset`);
    const key = Object.keys(j.result || {}).find((x) => x !== 'last');
    tok[k] = ((j.result || {})[key] || []).map((r) => [r[0] * 1000, +r[1], +r[2], +r[3], +r[4], +r[6]]);
  } catch (e) { console.log('token failed', k, String(e.message || e).slice(0, 100)); }
  await sleep(300);
}
if (WHAT !== 'fred') fs.writeFileSync('data/hist/kr_tok_1h.json.gz', zlib.gzipSync(JSON.stringify(tok)));
console.log('tokens', Object.keys(tok).length, Object.values(tok).reduce((a, r) => a + r.length, 0));
fs.writeFileSync('data/hist/meta.json', JSON.stringify({ built: new Date().toISOString(), days1m: DAYS_1M, from1h: new Date(FROM_1H).toISOString() }, null, 2) + '\n');
