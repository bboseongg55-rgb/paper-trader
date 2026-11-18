// Checks which keyless price sources answer from GitHub's servers and how fresh they are.
// Writes data/probe.json. Run by the "probe" mode of the workflow.
import fs from 'node:fs';
import * as S from './sources.mjs';

const SYMS = ['AAPL', 'MSFT', 'JPM', 'XOM', 'BRK/B'];
const out = { at: new Date().toISOString(), results: {} };
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const v = await fn();
    out.results[name] = { ok: true, ms: Date.now() - t0, sample: v };
  } catch (e) {
    out.results[name] = { ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 300) };
  }
  console.log(name, JSON.stringify(out.results[name]).slice(0, 400));
}
const pick = (m) => Object.fromEntries([...m.entries()].slice(0, 6));

await test('screener', async () => {
  const { rows, asof } = await S.screener();
  const a = rows.get('AAPL') || {};
  return { rows: rows.size, asof, AAPL: a, MSFT: rows.get('MSFT') || null };
});
await test('yahoo-chart', async () => ({ AAPL: await S.yahooChart('AAPL'), 'BRK/B': await S.yahooChart('BRK/B') }));
await test('yahoo-spark', async () => pick(await S.yahooSpark(SYMS)));
await test('cnbc', async () => pick(await S.cnbc(SYMS)));
await test('nasdaq-quote', async () => ({ AAPL: await S.nasdaqQuote('AAPL'), 'BRK/B': await S.nasdaqQuote('BRK/B') }));
await test('stooq', async () => pick(await S.stooq(SYMS)));
await test('index:yahoo-chart', async () => S.indexLevel('yahoo-chart'));
await test('index:cnbc', async () => S.indexLevel('cnbc'));
await test('index:nasdaq-index', async () => S.indexLevel('nasdaq-index'));
await test('index:stooq', async () => S.indexLevel('stooq'));
// bulk speed: 200 symbols with each multi-symbol source that answered
let syms = [];
try { syms = JSON.parse(fs.readFileSync('data/live.json', 'utf8')).days.slice(-1)[0].rows; syms = Object.keys(syms).slice(0, 200); } catch { syms = SYMS; }
for (const src of ['yahoo-spark', 'cnbc', 'stooq']) {
  if (!out.results[src] || !out.results[src].ok) continue;
  await test('bulk200:' + src, async () => { const m = await S.quotes(src, syms); return { asked: syms.length, got: m.size, first: pick(m) }; });
}
fs.writeFileSync('data/probe.json', JSON.stringify(out, null, 1));
