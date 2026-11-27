// One-off: which free public sources for earnings dates, company filings and stock news answer GitHub's servers
// (for tools/fetch_events.mjs and the nightly news). Prints status, size and a sample of each.
const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const UA_SEC = 'paper-trader research bot (github.com/bboseongg55-rgb/paper-trader) 41898282+github-actions[bot]@users.noreply.github.com';
const UA_SEC2 = 'paper-trader/1.0 (github.com/bboseongg55-rgb/paper-trader)';
const tests = [
  ['sec tickers', 'https://www.sec.gov/files/company_tickers.json', UA_SEC],
  ['sec submissions AAPL', 'https://data.sec.gov/submissions/CIK0000320193.json', UA_SEC],
  ['sec submissions AAPL (ua2)', 'https://data.sec.gov/submissions/CIK0000320193.json', UA_SEC2],
  ['sec submissions AAPL older', 'https://data.sec.gov/submissions/CIK0000320193-submissions-001.json', UA_SEC],
  ['sec companyconcept EPS', 'https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/EarningsPerShareDiluted.json', UA_SEC],
  ['sec daily index', 'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261125.idx', UA_SEC],
  ['nasdaq earnings calendar', 'https://api.nasdaq.com/api/calendar/earnings?date=2026-11-24', UA_BROWSER],
  ['nasdaq earnings calendar past', 'https://api.nasdaq.com/api/calendar/earnings?date=2025-07-31', UA_BROWSER],
  ['nasdaq earnings surprise', 'https://api.nasdaq.com/api/company/AAPL/earnings-surprise', UA_BROWSER],
  ['nasdaq news by symbol', 'https://www.nasdaq.com/api/news/topic/articlebysymbol?q=AAPL|stocks&offset=0&limit=10&fallback=false', UA_BROWSER],
  ['nasdaq press releases', 'https://www.nasdaq.com/api/news/topic/press_release?q=symbol:AAPL|assetclass:stocks&limit=10&offset=0', UA_BROWSER],
  ['nasdaq rss', 'https://www.nasdaq.com/feed/rssoutbound?symbol=AAPL', UA_BROWSER],
  ['google news rss', 'https://news.google.com/rss/search?q=AAPL+stock&hl=en-US&gl=US&ceid=US:en', UA_BROWSER],
  ['cnbc quote fundamentals', 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=AAPL&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1', UA_BROWSER],
];
for (const [name, url, ua] of tests) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json, text/plain, */*', 'Accept-Encoding': 'gzip, deflate' } });
    const t = await r.text();
    console.log(`${name}: HTTP ${r.status} ${t.length}B ${Date.now() - t0}ms :: ${t.slice(0, 260).replace(/\s+/g, ' ')}`);
    if (name === 'sec submissions AAPL' && r.ok) {
      const j = JSON.parse(t), f = j.filings.recent, k = [];
      for (let i = 0; i < f.form.length && k.length < 6; i++) if (f.form[i] === '8-K' && /2\.02/.test(f.items[i] || '')) k.push(`${f.filingDate[i]} ${f.acceptanceDateTime[i]} ${f.items[i]}`);
      console.log('  8-K 2.02:', k.join(' | '), '| files', JSON.stringify(j.filings.files).slice(0, 300), '| recent n', f.form.length, 'oldest', f.filingDate[f.filingDate.length - 1]);
    }
    if (name.startsWith('nasdaq earnings calendar') && r.ok) { const j = JSON.parse(t); const rows = (j.data && j.data.rows) || []; console.log('  rows', rows.length, JSON.stringify(rows.slice(0, 2)).slice(0, 500)); }
  } catch (e) { console.log(`${name}: error ${String(e.message || e).slice(0, 160)}`); }
  await new Promise((s) => setTimeout(s, 300));
}
