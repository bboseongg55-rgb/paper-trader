// Price sources that answer without an API key. Every function returns plain numbers in our symbol format
// (the Nasdaq screener's, e.g. "BRK/B"). Which ones work from GitHub's servers is checked by tools/probe.mjs
// and written to data/source.json; the collector only uses the sources listed there.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const NASDAQ_H = { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const num = (s) => {
  if (s == null) return NaN;
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  const v = parseFloat(String(s).replace(/[$,%\s]/g, ''));
  return Number.isFinite(v) ? v : NaN;
};

export async function getText(url, { headers = {}, timeout = 20000, tries = 2 } = {}) {
  let lastErr;
  for (let k = 0; k < tries; k++) {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', ...headers }, signal: ac.signal });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      return text;
    } catch (e) {
      lastErr = e;
      if (k + 1 < tries) await sleep(1500 * (k + 1));
    } finally {
      clearTimeout(tm);
    }
  }
  throw lastErr;
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { err: String(e.message || e) }; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ── Nasdaq stock screener: every listed stock with name, sector and market cap (one call per exchange)
export async function screener() {
  const rows = new Map(); let asof = null;
  for (const ex of ['nasdaq', 'nyse', 'amex']) {
    const txt = await getText(`https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&exchange=${ex}&download=true`, { headers: NASDAQ_H, timeout: 45000, tries: 3 });
    const j = JSON.parse(txt);
    const d = j.data || {};
    asof = asof || d.asOf || d.asof || null;
    for (const r of d.rows || []) {
      const s = String(r.symbol || '').trim();
      if (!s) continue;
      const px = num(r.lastsale), nc = num(r.netchange);
      rows.set(s, { px, prev: Number.isFinite(nc) ? px - nc : NaN, pct: num(r.pctchange), cap: num(r.marketCap), name: String(r.name || s), sec: String(r.sector || ''), src: 'screener' });
    }
  }
  return { rows, asof };
}

// ── Yahoo Finance chart (one symbol per call)
const ySym = (s) => s.replace('/', '-');
export async function yahooChart(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym(sym))}?range=1d&interval=5m&includePrePost=false`;
  const j = JSON.parse(await getText(url));
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('no result ' + JSON.stringify(j.chart && j.chart.error).slice(0, 120));
  const m = res.meta;
  return { px: num(m.regularMarketPrice), prev: num(m.chartPreviousClose ?? m.previousClose), time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null };
}

// ── Yahoo Finance spark (20 symbols per call)
export async function yahooSpark(syms) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < syms.length; i += 20) batches.push(syms.slice(i, i + 20));
  await pool(batches, 3, async (batch) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.map((s) => encodeURIComponent(ySym(s))).join(',')}&range=1d&interval=15m`;
    const j = JSON.parse(await getText(url));
    const back = new Map(batch.map((s) => [ySym(s), s]));
    const list = (j.spark && j.spark.result) || [];
    for (const it of list) {
      const m = it.response && it.response[0] && it.response[0].meta;
      if (!m) continue;
      out.set(back.get(it.symbol) || it.symbol, { px: num(m.regularMarketPrice), prev: num(m.chartPreviousClose ?? m.previousClose), time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null });
    }
    if (!list.length) for (const k in j) {           // newer shape: {SYM: {close: [...], timestamp: [...], chartPreviousClose}}
      const v = j[k];
      if (!v || !Array.isArray(v.close)) continue;
      const closes = v.close.filter((x) => x != null);
      const ts = (v.timestamp || []).filter((x) => x != null);
      out.set(back.get(k) || k, { px: num(closes[closes.length - 1]), prev: num(v.chartPreviousClose ?? v.previousClose), time: ts.length ? new Date(ts[ts.length - 1] * 1000).toISOString() : null });
    }
  });
  return out;
}

// ── CNBC quotes (40 symbols per call)
const cSym = (s) => s.replace('/', '.');
export async function cnbc(syms) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < syms.length; i += 40) batches.push(syms.slice(i, i + 40));
  await pool(batches, 3, async (batch) => {
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${batch.map((s) => encodeURIComponent(cSym(s))).join('%7C')}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
    const j = JSON.parse(await getText(url));
    let q = j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote;
    if (q && !Array.isArray(q)) q = [q];
    const back = new Map(batch.map((s) => [cSym(s), s]));
    for (const it of q || []) out.set(back.get(it.symbol) || it.symbol, { px: num(it.last), prev: num(it.previous_day_closing), hi: num(it.high), lo: num(it.low), time: it.last_time || null });
  });
  return out;
}

// ── Nasdaq quote (one symbol per call); assetclass stocks or index
const nSym = (s) => s.replace('/', '.');
export async function nasdaqQuote(sym, cls = 'stocks') {
  const j = JSON.parse(await getText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(nSym(sym))}/info?assetclass=${cls}`, { headers: NASDAQ_H }));
  const p = j.data && j.data.primaryData;
  if (!p) throw new Error('no data ' + JSON.stringify(j.status || {}).slice(0, 120));
  const px = num(p.lastSalePrice), chg = num(p.netChange);
  return { px, prev: Number.isFinite(chg) ? px - chg : NaN, time: p.lastTradeTimestamp || null, rt: p.isRealTime };
}

// ── Stooq (40 symbols per call, CSV)
export async function stooq(syms) {
  const out = new Map();
  const code = (s) => (s.startsWith('^') ? s.toLowerCase() : s.toLowerCase().replace('/', '-') + '.us');
  for (let i = 0; i < syms.length; i += 40) {
    const batch = syms.slice(i, i + 40);
    const back = new Map(batch.map((s) => [code(s).toUpperCase(), s]));
    const txt = await getText(`https://stooq.com/q/l/?s=${batch.map(code).join('+')}&f=sd2t2ohlcv&h&e=csv`, { headers: { Accept: 'text/csv,*/*' } });
    for (const line of txt.trim().split(/\r?\n/).slice(1)) {
      const p = line.split(',');
      if (p.length < 7 || p[1] === 'N/D') continue;
      out.set(back.get(p[0].toUpperCase()) || p[0], { px: num(p[6]), prev: NaN, time: `${p[1]} ${p[2]}` });
    }
  }
  return out;
}

// ── One interface for the collector: quotes for many symbols with the named source
export async function quotes(source, syms) {
  if (!syms.length) return new Map();
  if (source === 'fixture') { const j = JSON.parse((await import('node:fs')).readFileSync(process.env.FIXTURE, 'utf8')); return new Map(syms.filter((s) => j[s]).map((s) => [s, j[s]])); }   // local tests only
  if (source === 'yahoo-spark') return yahooSpark(syms);
  if (source === 'cnbc') return cnbc(syms);
  if (source === 'stooq') return stooq(syms);
  if (source === 'yahoo-chart' || source === 'nasdaq-quote') {
    const fn = source === 'yahoo-chart' ? (s) => yahooChart(s) : (s) => nasdaqQuote(s);
    const res = await pool(syms, 4, fn);
    const out = new Map();
    syms.forEach((s, k) => { if (res[k] && Number.isFinite(res[k].px)) out.set(s, res[k]); });
    return out;
  }
  throw new Error('unknown source ' + source);
}

// S&P 500 index level
export async function indexLevel(source) {
  if (source === 'fixture') { const j = JSON.parse((await import('node:fs')).readFileSync(process.env.FIXTURE, 'utf8')); return j['^GSPC'] || null; }
  if (source === 'yahoo-chart') return yahooChart('^GSPC');
  if (source === 'cnbc') { const m = await cnbc(['.SPX']); return m.get('.SPX') || null; }
  if (source === 'nasdaq-index') return nasdaqQuote('SPX', 'index');
  if (source === 'stooq') { const m = await stooq(['^spx']); return m.get('^spx') || null; }
  return null;
}
