// Checks, from GitHub's servers, the keyless sources the combined account needs beyond what probe_assets.mjs covered:
// tokenized US stocks on Kraken (xStocks, traded around the clock), the next futures contract and how the front
// contract's history behaves across a roll, volatility and short-rate history, and more option chains.
// Writes data/probe_more.json. Run by the "probe-more" mode of the workflow.
import fs from 'node:fs';
import * as S from './sources.mjs';

const out = { at: new Date().toISOString(), results: {} };
const short = (v, n = 600) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };
async function test(name, fn) {
  const t0 = Date.now();
  try { out.results[name] = { ok: true, ms: Date.now() - t0, sample: await fn() }; }
  catch (e) { out.results[name] = { ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 300) }; }
  out.results[name].ms = Date.now() - t0;
  console.log(name, short(out.results[name], 400));
}
const get = (url, opt) => S.getText(url, Object.assign({ timeout: 20000, tries: 1 }, opt || {}));
const getJ = async (url, opt) => JSON.parse(await get(url, opt));

// 1. Kraken xStocks: the pair list, quotes, hourly candles and order-book depth
let xs = [];
await test('kraken:pairs-tokenized', async () => {
  const j = await getJ('https://api.kraken.com/0/public/AssetPairs?aclass_base=tokenized_asset');
  if (j.error && j.error.length) throw new Error(j.error.join(';'));
  const r = Object.entries(j.result || {});
  xs = r.map(([k, v]) => ({ key: k, alt: v.altname, ws: v.wsname, quote: v.quote, base: v.base, aclass: v.aclass_base, lot: v.lot_decimals, ordermin: v.ordermin, status: v.status }));
  return { n: r.length, usd: xs.filter((x) => /USD$/.test(x.alt || '')).length, first: xs.slice(0, 12), names: xs.map((x) => x.alt).filter((a) => /USD$/.test(a)).slice(0, 400) };
});
await test('kraken:pairs-all-x', async () => {
  const j = await getJ('https://api.kraken.com/0/public/AssetPairs');
  const r = Object.entries(j.result || {}).filter(([k, v]) => /x\/USD$/.test(v.wsname || ''));
  return { n: r.length, first: r.slice(0, 5).map(([k, v]) => ({ key: k, alt: v.altname, ws: v.wsname, aclass: v.aclass_base })) };
});
const WANT = ['SPYx', 'QQQx', 'IWMx', 'NVDAx', 'TSLAx', 'AAPLx', 'MSFTx', 'GOOGLx', 'AMZNx', 'METAx', 'GLDx', 'TLTx'];
for (const variant of ['', '&asset_class=tokenized_asset']) {
  await test('kraken:ticker' + (variant ? '-aclass' : ''), async () => {
    const pairs = WANT.map((s) => s + 'USD').join(',');
    const j = await getJ(`https://api.kraken.com/0/public/Ticker?pair=${pairs}${variant}`);
    if (j.error && j.error.length && !Object.keys(j.result || {}).length) throw new Error(j.error.join(';'));
    return { err: j.error, got: Object.fromEntries(Object.entries(j.result || {}).map(([k, r]) => [k, { bid: r.b && r.b[0], ask: r.a && r.a[0], last: r.c && r.c[0], vol24: r.v && r.v[1], trades24: r.t && r.t[1] }])) };
  });
}
for (const variant of ['', '&asset_class=tokenized_asset']) {
  await test('kraken:ohlc-SPYx' + (variant ? '-aclass' : ''), async () => {
    const j = await getJ(`https://api.kraken.com/0/public/OHLC?pair=SPYxUSD&interval=60${variant}`);
    if (j.error && j.error.length) throw new Error(j.error.join(';'));
    const k = Object.keys(j.result || {}).find((x) => x !== 'last'), rows = (j.result || {})[k] || [];
    return { key: k, n: rows.length, first: rows[0], last: rows[rows.length - 1] };
  });
  await test('kraken:depth-SPYx' + (variant ? '-aclass' : ''), async () => {
    const j = await getJ(`https://api.kraken.com/0/public/Depth?pair=SPYxUSD&count=5${variant}`);
    if (j.error && j.error.length) throw new Error(j.error.join(';'));
    return j.result;
  });
}

// 2. futures: the front and next contracts with their names (contract months), and the front contract's daily bars
//    around recent rolls next to the next contract's, to see whether the history is stitched with jumps
const FUT = ['@SP', '@ND', '@DJ', '@TFS', '@TU', '@FV', '@TY', '@US', '@CL', '@GC', '@SI', '@HG', '@NG', '@BTC', '@ETH', '@JY', '@EC', '@BP', '@AD', '@CD'];
await test('cnbc:futures-names', async () => {
  const syms = FUT.flatMap((f) => [f + '.1', f + '.2']);
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms.map(encodeURIComponent).join('%7C')}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
  const j = JSON.parse(await get(url));
  let q = j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote; if (q && !Array.isArray(q)) q = [q];
  return (q || []).map((x) => ({ s: x.symbol, name: x.name, last: x.last, prev: x.previous_day_closing, t: x.last_time, exp: x.expiration_date || x.contract_expiration || null, keys: Object.keys(x).filter((k) => /exp|month|contract|settle|open_int/i.test(k)) }));
});
const bars = async (sym, from = '20250101000000', to = '20261119000000') => {
  const j = JSON.parse(await get(`https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${from}/${to}/adjusted/EST5EDT.json`));
  return ((j.barData && j.barData.priceBars) || []).map((b) => [b.tradeTime.slice(0, 8), +b.close]);
};
for (const f of ['@SP', '@CL', '@GC', '@TY', '@TFS', '@BTC']) {
  await test('cnbc:bars-' + f, async () => {
    const a = await bars(f + '.1'), b = await bars(f + '.2').catch(() => []);
    const B = new Map(b);
    // the biggest one-day moves of the front contract, with the next contract's move the same day
    const moves = [];
    for (let i = 1; i < a.length; i++) moves.push({ d: a[i][0], r1: a[i][1] / a[i - 1][1] - 1, r2: B.has(a[i][0]) && B.has(a[i - 1][0]) ? B.get(a[i][0]) / B.get(a[i - 1][0]) - 1 : null, c1: a[i][1], c2: B.get(a[i][0]) || null });
    const big = moves.slice().sort((x, y) => Math.abs(y.r1 - (y.r2 || 0)) - Math.abs(x.r1 - (x.r2 || 0))).slice(0, 6);
    return { n1: a.length, n2: b.length, first: a[0], last: a[a.length - 1], biggestGap: big };
  });
}
// 3. volatility and short-rate history
for (const s of ['.VIX', '.VXN', '.RUT', 'US1M', 'US3M', '.MOVE', '.DXY']) {
  await test('cnbc:bars-' + s, async () => { const a = await bars(s, '20240101000000'); return { n: a.length, first: a[0], last: a[a.length - 1] }; });
}
for (const id of ['DTB4WK', 'DFF', 'SOFR', 'BAMLH0A0HYM2', 'T10Y2Y', 'DTWEXBGS']) {
  await test('fred:' + id, async () => { const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`); const L = t.trim().split(/\r?\n/); return { rows: L.length, head: L[0], last: L[L.length - 1] }; });
}
for (const f of ['VXN_History.csv', 'RVX_History.csv', 'VIX3M_History.csv']) {
  await test('cboe:' + f, async () => { const t = await get('https://cdn.cboe.com/api/global/us_indices/daily_prices/' + f); const L = t.trim().split(/\r?\n/); return { rows: L.length, head: L[0], first: L[1], last: L[L.length - 1] }; });
}
// 4. more option chains (index ETFs and the S&P 500 index itself)
for (const s of ['QQQ', 'IWM', '_SPX', 'TLT', 'GLD']) {
  await test('cboe:opt-' + s, async () => {
    const t = await get(`https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`, { timeout: 40000 });
    const j = JSON.parse(t), o = (j.data && j.data.options) || [];
    const exps = [...new Set(o.map((x) => x.option.replace(/^[A-Z_]+?(\d{6})[CP]\d+$/, '$1')))].slice(0, 12);
    return { bytes: t.length, n: o.length, price: j.data && j.data.current_price, exps, sample: o.find((x) => x.open_interest > 100) || o[0] };
  });
}
// 5. Hyperliquid: listed perpetual markets, including stock perps on builder-deployed exchanges
const hl = async (body) => { const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000) }); const t = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 160)}`); return t; };
await test('hyperliquid:perpDexs', async () => { const t = await hl({ type: 'perpDexs' }); return short(t, 1500); });
// 6. Deribit: BTC and ETH futures (perpetual included) and the BTC volatility index
await test('deribit:futures', async () => {
  const r = [];
  for (const c of ['BTC', 'ETH']) { const j = await getJ(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${c}&kind=future`); r.push(...(j.result || []).map((x) => ({ i: x.instrument_name, bid: x.bid_price, ask: x.ask_price, mark: x.mark_price, oi: x.open_interest, f8: x.funding_8h ?? null }))); }
  return r;
});
fs.writeFileSync('data/probe_more.json', JSON.stringify(out, null, 1));
console.log('done', Object.values(out.results).filter((r) => r.ok).length, '/', Object.keys(out.results).length);
