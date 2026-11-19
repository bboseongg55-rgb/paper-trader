// Which public price sources a web page may read directly (CORS), how fresh their quotes are, and whether CNBC
// serves intraday bars. Prints to the job log only. Run by the probe workflow.
const ORIGIN = 'https://bboseongg55-rgb.github.io';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const pad = (n) => String(n).padStart(2, '0');
const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const ymd = `${et.getFullYear()}${pad(et.getMonth() + 1)}${pad(et.getDate())}`;
const QS = 'requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&events=1';
const SY = ['VCIT', '.RUT', '.DJI', 'US2Y', 'US5Y', 'US10Y', 'US30Y', '@TU.1', '@TU.2', '@TFS.1', '@SP.1', '@BTC.1', '@ETH.1', '@SI.1', '@HG.1', 'BTC.CM='].map(encodeURIComponent).join('%7C');
const bar = (sym, iv, a, b) => `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/${iv}/${a}/${b}/adjusted/EST5EDT.json`;
const urls = [
  ['cnbc quote', `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${SY}&${QS}&output=json`],
  ['cnbc bars 1M @TFS.1', bar('@TFS.1', '1M', ymd + '000000', ymd + '235959')],
  ['cnbc bars 1M @SP.1', bar('@SP.1', '1M', ymd + '000000', ymd + '235959')],
  ['cnbc bars 1M @TU.1', bar('@TU.1', '1M', ymd + '000000', ymd + '235959')],
  ['cnbc bars 1M @GC.1', bar('@GC.1', '1M', ymd + '000000', ymd + '235959')],
  ['cnbc bars 1M .RUT', bar('.RUT', '1M', ymd + '000000', ymd + '235959')],
  ['cnbc bars 1M .SPX', bar('.SPX', '1M', ymd + '000000', ymd + '235959')],
  ['cnbc bars 1M SPY', bar('SPY', '1M', ymd + '000000', ymd + '235959')],
  ['cnbc bars 30M @TU.2', bar('@TU.2', '30M', '20261112000000', ymd + '235959')],
  ['cnbc bars 1H @TFS.1', bar('@TFS.1', '1H', '20261020000000', ymd + '235959')],
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
        for (const x of q || []) console.log(`   ${x.symbol}: ${x.name} | last ${x.last} at ${x.last_time} | realTime=${x.realTime} | ${x.curmktstatus || ''} | prev ${x.previous_day_closing} | chg ${x.change}`);
      } catch (e) { console.log('   parse error ' + e.message); }
    }
    if (/bars/.test(name)) {
      try { const j = JSON.parse(body); const b = (j.barData && j.barData.priceBars) || []; console.log(`   bars ${b.length}: first ${b[0] && b[0].tradeTime} last ${b.length && b[b.length - 1].tradeTime} close ${b.length && b[b.length - 1].close} | last3 ${b.slice(-3).map((x) => x.tradeTime.slice(8, 12) + ':' + x.close).join(' ')} | now ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })}`); } catch (e) { console.log('   parse error ' + e.message); }
    }
  } catch (e) { console.log(`\n== ${name}: ERROR ${String(e.message || e).slice(0, 200)}`); }
}
console.log('\nnow ET', et.toString());
