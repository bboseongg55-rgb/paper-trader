// Which public price sources a web page may read directly (CORS), how fresh their quotes are, and whether CNBC
// serves intraday bars. Prints to the job log only. Run by the probe workflow.
const ORIGIN = 'https://bboseongg55-rgb.github.io';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const pad = (n) => String(n).padStart(2, '0');
const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const ymd = `${et.getFullYear()}${pad(et.getMonth() + 1)}${pad(et.getDate())}`;
const QS = 'requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&events=1';
const SY = ['AAPL', 'SPY', '.SPX', '.NDX', '@ES.1', '@TU.1', '@RTY.1', '@CL.1', '@GC.1'].map(encodeURIComponent).join('%7C');
const urls = [
  ['cnbc quote', `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${SY}&${QS}&output=json`],
  ['cnbc quote jsonp', `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=AAPL&${QS}&output=jsonp&callback=cb`],
  ['cnbc bars 1M', `https://ts-api.cnbc.com/harmony/app/bars/AAPL/1M/${ymd}000000/${ymd}235959/adjusted/EST5EDT.json`],
  ['cnbc bars 5M', `https://ts-api.cnbc.com/harmony/app/bars/AAPL/5M/${ymd}000000/${ymd}235959/adjusted/EST5EDT.json`],
  ['cnbc bars 5M fut', `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent('@ES.1')}/5M/${ymd}000000/${ymd}235959/adjusted/EST5EDT.json`],
  ['cnbc bars 1D', `https://ts-api.cnbc.com/harmony/app/bars/AAPL/1D/20261101000000/${ymd}235959/adjusted/EST5EDT.json`],
  ['cnbc chart 1D', `https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol=AAPL`],
  ['cboe quote', 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json'],
  ['cboe options', 'https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json'],
  ['nasdaq', 'https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks'],
  ['yahoo chart', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1m'],
  ['stooq', 'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=json'],
  ['kraken ohlc', 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5'],
  ['kraken tok ohlc', 'https://api.kraken.com/0/public/OHLC?pair=AAPLxUSD&interval=5&asset_class=tokenized_asset'],
  ['coinbase candles', 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300'],
];
for (const [name, u] of urls) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { headers: { Origin: ORIGIN, 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    console.log(`\n== ${name}: HTTP ${r.status} in ${Date.now() - t0}ms | ACAO=${r.headers.get('access-control-allow-origin')} | ctype=${r.headers.get('content-type')} | cache=${r.headers.get('cache-control')} | len=${body.length}`);
    console.log('   ' + body.slice(0, 420).replace(/\s+/g, ' '));
    if (name === 'cnbc quote') {
      try {
        const j = JSON.parse(body); let q = j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote; if (q && !Array.isArray(q)) q = [q];
        for (const x of q || []) console.log(`   ${x.symbol}: last ${x.last} at ${x.last_time} | realTime=${x.realTime} | ${x.curmktstatus || ''} | ext ${x.ExtendedMktQuote ? x.ExtendedMktQuote.last + ' ' + x.ExtendedMktQuote.last_time : '-'} | keys ${Object.keys(x).slice(0, 40).join(',')}`);
      } catch (e) { console.log('   parse error ' + e.message); }
    }
    if (/bars/.test(name)) {
      try { const j = JSON.parse(body); const b = (j.barData && j.barData.priceBars) || []; console.log(`   bars ${b.length}: first ${b[0] && b[0].tradeTime} last ${b.length && b[b.length - 1].tradeTime} ${b.length && b[b.length - 1].close}`); } catch (e) { console.log('   parse error ' + e.message); }
    }
  } catch (e) { console.log(`\n== ${name}: ERROR ${String(e.message || e).slice(0, 200)}`); }
}
console.log('\nnow ET', et.toString());
