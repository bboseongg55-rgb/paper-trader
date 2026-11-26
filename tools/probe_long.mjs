// One-off: how far back CNBC's daily bars go and whether one request returns a whole range (for tools/fetch_long.mjs)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const bars = async (sym, a, b) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${a}/${b}/adjusted/EST5EDT.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const t = await r.text();
    if (!r.ok) return `${sym} HTTP ${r.status} ${t.slice(0, 80)}`;
    const j = JSON.parse(t), p = (j.barData && j.barData.priceBars) || [];
    const f = p[0], l = p[p.length - 1];
    return `${sym} ${a.slice(0, 8)}-${b.slice(0, 8)} n=${p.length} first=${f && f.tradeTime} ${f && f.close} last=${l && l.tradeTime} ${l && l.close} ms=${Date.now() - t0}`;
  } catch (e) { return `${sym} error ${String(e.message || e).slice(0, 100)}`; }
};
const W = ['20090101000000', '20240301000000'];
for (const [s, a, b] of [['AAPL', ...W], ['MSFT', ...W], ['BRK.B', ...W], ['XOM', ...W], ['TWTR', ...W], ['XLNX', ...W], ['ATVI', ...W], ['CELG', ...W],
  ['AAPL', '20090101000000', '20101231235959'], ['AAPL', '19900101000000', '20261126235959'],
  ['.SPX', '20070101000000', '20261126235959'], ['.VIX', '20070101000000', '20261126235959'], ['VCIT', '20070101000000', '20261126235959'],
  ['@SP.1', '20070101000000', '20261126235959'], ['@TY.1', '20070101000000', '20261126235959'], ['@CL.1', '20070101000000', '20261126235959'], ['@BTC.1', '20170101000000', '20261126235959'],
  ['BTC.CM=', '20140101000000', '20261126235959'], ['@SP.1', '20070101000000', '20121231235959']]) console.log(await bars(s, a, b));
// the speed of many in a row
const t0 = Date.now(); let ok = 0;
for (const s of ['A', 'AAL', 'AAP', 'ABBV', 'ABC', 'ABT', 'ACN', 'ADBE', 'ADI', 'ADM', 'ADP', 'ADSK', 'AEE', 'AEP', 'AES', 'AFL', 'AIG', 'AIZ', 'AJG', 'AKAM']) { const r = await bars(s, ...W); if (/ n=\d{3,}/.test(r)) ok++; }
console.log('20 in a row', ok, 'ok', Date.now() - t0, 'ms');
