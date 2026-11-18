// Checks which keyless sources answer from GitHub's servers for the asset classes beyond US stocks: government bond
// yields by country, currencies, futures, the VIX, bond ETFs, option chains, crypto exchanges, and price history.
// Writes data/probe_assets.json. Run by the "probe-assets" mode of the workflow.
import fs from 'node:fs';
import * as S from './sources.mjs';

const out = { at: new Date().toISOString(), results: {} };
const short = (v, n = 600) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const v = await fn();
    out.results[name] = { ok: true, ms: Date.now() - t0, sample: v };
  } catch (e) {
    out.results[name] = { ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 240) };
  }
  console.log(name, short(out.results[name], 300));
}
const get = (url, opt) => S.getText(url, Object.assign({ timeout: 15000, tries: 1 }, opt || {}));
const getJ = async (url, opt) => JSON.parse(await get(url, opt));

// 1. CNBC quotes: yields, currencies, futures, indexes, bond ETFs, crypto reference prices
const CNBC = {
  yields: ['US1M', 'US3M', 'US2Y', 'US5Y', 'US10Y', 'US30Y', 'DE2Y-DE', 'DE10Y-DE', 'GB10Y-GB', 'JP10Y-JP', 'FR10Y-FR', 'IT10Y-IT', 'ES10Y-ES', 'PT10Y-PT', 'GR10Y-GR', 'NL10Y-NL',
    'CH10Y-CH', 'SE10Y-SE', 'NO10Y-NO', 'CA10Y-CA', 'AU10Y-AU', 'NZ10Y-NZ', 'KR10Y-KR', 'CN10Y-CN', 'IN10Y-IN', 'BR10Y-BR', 'MX10Y-MX', 'ZA10Y-ZA', 'SG10Y-SG', 'HK10Y-HK', 'ID10Y-ID', 'TR10Y-TR', 'PL10Y-PL'],
  fx: ['EUR=', 'GBP=', 'JPY=', 'CHF=', 'CAD=', 'AUD=', 'NZD=', 'SEK=', 'NOK=', 'KRW=', 'CNY=', 'INR=', 'BRL=', 'MXN=', 'ZAR=', 'SGD=', 'HKD=', 'IDR=', 'TRY=', 'PLN='],
  futures: ['@SP.1', '@ND.1', '@DJ.1', '@TFS.1', '@MES.1', '@MNQ.1', '@TU.1', '@FV.1', '@TY.1', '@US.1', '@CL.1', '@GC.1', '@SI.1', '@HG.1', '@NG.1', '@BTC.1', '@ETH.1', '@EU.1', '@JY.1'],
  index: ['.VIX', '.SPX', '.NDX', '.DJI', '.RUT', '.MOVE'],
  bondEtf: ['BIL', 'SHV', 'SHY', 'IEI', 'IEF', 'TLH', 'TLT', 'GOVT', 'TIP', 'AGG', 'BND', 'LQD', 'VCIT', 'VCSH', 'IGIB', 'HYG', 'JNK', 'USHY', 'EMB', 'EMLC', 'PCY', 'BWX', 'IGOV', 'BNDX', 'MUB', 'FLOT', 'EDV', 'ZROZ'],
  crypto: ['BTC.CM=', 'ETH.CM=', 'BTC.CB=', 'ETH.CB='],
};
for (const [grp, syms] of Object.entries(CNBC)) {
  await test('cnbc:' + grp, async () => {
    const m = await S.cnbc(syms);
    const got = Object.fromEntries([...m.entries()].map(([k, v]) => [k, { px: v.px, prev: v.prev, time: v.time }]));
    return { asked: syms.length, got: m.size, missing: syms.filter((s) => !m.has(s)), quotes: got };
  });
}
// the raw CNBC fields for one yield, one currency and one future (names, types, units)
await test('cnbc:raw', async () => {
  const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US10Y%7CEUR%3D%7C%40SP.1%7CDE10Y-DE&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
  const j = await getJ(url);
  let q = j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote; if (q && !Array.isArray(q)) q = [q];
  return (q || []).map((it) => ({ symbol: it.symbol, name: it.name, type: it.type, assetType: it.assetType, last: it.last, change: it.change, previous_day_closing: it.previous_day_closing, last_time: it.last_time, bond_last_price: it.bond_last_price, coupon: it.coupon, maturity: it.maturity_date || it.maturityDate }));
});
// 2. history: CNBC chart bars, FRED csv, Nasdaq historical, Stooq daily, CBOE VIX history
await test('hist:cnbc-bars-US10Y', async () => { const t = await get('https://ts-api.cnbc.com/harmony/app/bars/US10Y/1D/20250101000000/20261118000000/adjusted/EST5EDT.json'); return { bytes: t.length, head: t.slice(0, 400) }; });
await test('hist:cnbc-bars-DE10Y', async () => { const t = await get('https://ts-api.cnbc.com/harmony/app/bars/DE10Y-DE/1D/20250101000000/20261118000000/adjusted/EST5EDT.json'); return { bytes: t.length, head: t.slice(0, 300) }; });
await test('hist:cnbc-bars-EUR', async () => { const t = await get('https://ts-api.cnbc.com/harmony/app/bars/EUR%3D/1D/20250101000000/20261118000000/adjusted/EST5EDT.json'); return { bytes: t.length, head: t.slice(0, 300) }; });
await test('hist:cnbc-bars-TLT', async () => { const t = await get('https://ts-api.cnbc.com/harmony/app/bars/TLT/1D/20240101000000/20261118000000/adjusted/EST5EDT.json'); return { bytes: t.length, head: t.slice(0, 300) }; });
await test('hist:cnbc-bars-ES', async () => { const t = await get('https://ts-api.cnbc.com/harmony/app/bars/%40SP.1/1D/20250101000000/20261118000000/adjusted/EST5EDT.json'); return { bytes: t.length, head: t.slice(0, 300) }; });
await test('hist:cnbc-bars-1min-SPY', async () => { const t = await get('https://ts-api.cnbc.com/harmony/app/bars/SPY/1M/20261118093000/20261118160000/adjusted/EST5EDT.json'); return { bytes: t.length, head: t.slice(0, 300) }; });
for (const id of ['DGS10', 'DGS2', 'DTB3', 'BAMLC0A0CM', 'BAMLH0A0HYM2', 'DEXJPUS', 'DEXKOUS', 'IRLTLT01DEM156N']) {
  await test('hist:fred-' + id, async () => { const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`); const L = t.trim().split(/\r?\n/); return { rows: L.length, first: L[1], last: L[L.length - 1] }; });
}
await test('hist:nasdaq-TLT', async () => { const j = await getJ('https://api.nasdaq.com/api/quote/TLT/historical?assetclass=etf&fromdate=2024-11-01&todate=2026-11-18&limit=9999', { headers: { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } }); const r = j.data && j.data.tradesTable && j.data.tradesTable.rows; return { rows: r ? r.length : 0, first: r && r[0], last: r && r[r.length - 1] }; });
await test('hist:stooq-tlt', async () => { const t = await get('https://stooq.com/q/d/l/?s=tlt.us&i=d'); const L = t.trim().split(/\r?\n/); return { rows: L.length, first: L[1], last: L[L.length - 1] }; });
await test('hist:cboe-vix', async () => { const t = await get('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'); const L = t.trim().split(/\r?\n/); return { rows: L.length, head: L[0], last: L[L.length - 1] }; });
// 3. option chains
await test('opt:cboe-SPY', async () => {
  const t = await get('https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json', { timeout: 30000 });
  const j = JSON.parse(t), d = j.data || {}, o = d.options || [];
  return { bytes: t.length, timestamp: j.timestamp, price: d.current_price, n: o.length, first: o[0], mid: o[Math.floor(o.length / 2)] };
});
await test('opt:cboe-AAPL', async () => { const t = await get('https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json', { timeout: 30000 }); const j = JSON.parse(t); return { bytes: t.length, n: (j.data && j.data.options || []).length, timestamp: j.timestamp }; });
await test('opt:nasdaq-SPY', async () => { const j = await getJ('https://api.nasdaq.com/api/quote/SPY/option-chain?assetclass=etf&limit=10', { headers: { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } }); return short(j, 500); });
await test('opt:deribit-BTC', async () => { const j = await getJ('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option'); return { n: (j.result || []).length, first: (j.result || [])[0] }; });
await test('fut:deribit-BTC', async () => { const j = await getJ('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future'); return { n: (j.result || []).length, first: (j.result || [])[0] }; });
// 4. crypto exchanges: top of book for BTC (who answers from a US data centre, and how fast)
const EX = {
  coinbase: ['https://api.exchange.coinbase.com/products/BTC-USD/book?level=1', (j) => ({ bid: j.bids && j.bids[0], ask: j.asks && j.asks[0] })],
  kraken: ['https://api.kraken.com/0/public/Ticker?pair=XBTUSD', (j) => { const r = j.result && Object.values(j.result)[0]; return r ? { bid: r.b, ask: r.a } : j; }],
  bitstamp: ['https://www.bitstamp.net/api/v2/ticker/btcusd/', (j) => ({ bid: j.bid, ask: j.ask, ts: j.timestamp })],
  gemini: ['https://api.gemini.com/v1/pubticker/btcusd', (j) => ({ bid: j.bid, ask: j.ask })],
  binanceus: ['https://api.binance.us/api/v3/ticker/bookTicker?symbol=BTCUSDT', (j) => j],
  binance: ['https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT', (j) => j],
  okx: ['https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT', (j) => (j.data && j.data[0] ? { bid: j.data[0].bidPx, ask: j.data[0].askPx } : j)],
  bybit: ['https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', (j) => (j.result && j.result.list ? { bid: j.result.list[0].bid1Price, ask: j.result.list[0].ask1Price } : j)],
  kucoin: ['https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT', (j) => j.data || j],
  bitfinex: ['https://api-pub.bitfinex.com/v2/ticker/tBTCUSD', (j) => ({ bid: j[0], bidSize: j[1], ask: j[2], askSize: j[3] })],
  cryptocom: ['https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTC_USD', (j) => (j.result && j.result.data ? { bid: j.result.data[0].b, ask: j.result.data[0].k } : j)],
  gateio: ['https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT', (j) => (j[0] ? { bid: j[0].highest_bid, ask: j[0].lowest_ask } : j)],
  mexc: ['https://api.mexc.com/api/v3/ticker/bookTicker?symbol=BTCUSDT', (j) => j],
  htx: ['https://api.huobi.pro/market/detail/merged?symbol=btcusdt', (j) => (j.tick ? { bid: j.tick.bid, ask: j.tick.ask } : j)],
  bitget: ['https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT', (j) => (j.data && j.data[0] ? { bid: j.data[0].bidPr, ask: j.data[0].askPr } : j)],
  upbit: ['https://api.upbit.com/v1/orderbook?markets=KRW-BTC', (j) => (j[0] ? { bid: j[0].orderbook_units[0].bid_price, ask: j[0].orderbook_units[0].ask_price } : j)],
  bithumb: ['https://api.bithumb.com/public/orderbook/BTC_KRW?count=1', (j) => (j.data ? { bid: j.data.bids[0], ask: j.data.asks[0] } : j)],
};
await Promise.all(Object.entries(EX).map(([k, [url, f]]) => test('crypto:' + k, async () => f(await getJ(url)))));
await test('crypto:coinbase-candles', async () => { const j = await getJ('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400'); return { n: j.length, first: j[0], last: j[j.length - 1] }; });
await test('crypto:coinbase-fees-public', async () => short(await get('https://api.exchange.coinbase.com/products/BTC-USD'), 400));

fs.writeFileSync('data/probe_assets.json', JSON.stringify(out, null, 1));
console.log('done', Object.values(out.results).filter((r) => r.ok).length, 'of', Object.keys(out.results).length, 'answered');
