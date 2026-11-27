// One-off: which free public sources for earnings dates, company filings and stock news answer GitHub's servers
// (2026-11-27: SEC answers 403 to GitHub's servers; Nasdaq's earnings calendar, news and RSS, Google News RSS and CNBC
// quotes answer). This run: how far back Nasdaq's earnings calendar goes and what its old rows carry.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
for (const d of ['2008-07-22', '2009-10-20', '2010-07-20', '2011-10-18', '2012-04-24', '2014-01-28', '2016-07-26', '2018-05-01', '2020-04-28', '2022-10-25', '2024-04-25']) {
  try {
    const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const j = await r.json(), rows = (j.data && j.data.rows) || [];
    const big = rows.filter((x) => ['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'GOOG', 'META', 'FB', 'T', 'VZ', 'KO', 'MMM', 'CAT', 'PFE', 'MRK', 'BA', 'XOM', 'CVX', 'INTC', 'IBM', 'JNJ'].includes(x.symbol));
    const times = {}; for (const x of rows) times[x.time] = (times[x.time] || 0) + 1;
    console.log(d, 'HTTP', r.status, 'rows', rows.length, 'times', JSON.stringify(times), 'big', JSON.stringify(big.slice(0, 3)).slice(0, 420));
  } catch (e) { console.log(d, 'error', String(e.message || e).slice(0, 120)); }
  await new Promise((s) => setTimeout(s, 300));
}
// the surprise table for one company: how many quarters back
try {
  const r = await fetch('https://api.nasdaq.com/api/company/MSFT/earnings-surprise', { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  console.log('surprise MSFT', JSON.stringify(await r.json()).slice(0, 900));
} catch (e) { console.log('surprise error', e.message); }
