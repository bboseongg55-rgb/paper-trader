// Intraday collector. GitHub Actions runs it about every 15 minutes; it does nothing outside the US session.
// 1. once a day: the list of large US stocks (name, sector, market cap) from the Nasdaq screener -> data/universe.json
// 2. live prices for that list and for the stocks held, and the S&P 500 level (sources in data/source.json); the Nasdaq
//    100 and Dow Jones levels too, for the page's comparison chart only
// 3. yesterday's official closes if they are missing (from the previous-close field of the same quotes)
// 4. today's row: provisional while the market is open (data/today.json, not committed), final from 15:40 New York time
//    (written into data/live.json); every run's prices of the whole list are also kept in data/intraday/DATE.json,
//    which is what the engine uses for day trades and for stops during the day
import fs from 'node:fs';
import * as S from './sources.mjs';

const FORCE = process.argv.includes('--force');
const HOLIDAYS = new Set(['2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
const BAD_NAME = /warrant|\bunits?\b|\bright(s)?\b|preferred|pfd|depositary shares representing|notes due|debenture|subordinated|trust preferred|% /i;
const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
const r2 = (v) => (v >= 10 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
const cleanName = (n) => String(n).replace(/\s+(Common Stock|Class A Common Stock|Ordinary Shares|American Depositary Shares)\b.*$/, '').slice(0, 40);

function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
const isTradingDay = (date) => { const wd = new Date(date + 'T12:00:00Z').getUTCDay(); return wd >= 1 && wd <= 5 && !HOLIDAYS.has(date); };
function prevTradingDay(date) {
  let d = new Date(date + 'T12:00:00Z');
  do { d = new Date(d.getTime() - 864e5); } while (!isTradingDay(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
}
// a quote counts for today only if its trade time is today in New York (or the source gives no time)
function tradeDate(time) {
  if (!time) return null;
  const d = new Date(String(time).replace(/ ET$/, ' EST').replace(/^DATA AS OF /i, ''));
  return isNaN(d) ? null : etParts(d).date;
}

const out = (o) => {
  console.log(JSON.stringify(o));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${o.changed ? 'true' : 'false'}\n`);
};

const t0 = Date.now();
const now = process.env.ET_NOW ? { date: process.env.ET_NOW.slice(0, 10), hm: process.env.ET_NOW.slice(11, 16) } : etParts();   // ET_NOW: tests only
const today = now.date;
if (!FORCE && !isTradingDay(today)) { out({ changed: false, skip: '휴장일', et: now }); process.exit(0); }
const early = EARLY_CLOSE.has(today);
const finalFrom = early ? '12:50' : '15:50', gateEnd = early ? '13:40' : '16:40';
if (!FORCE && (now.hm < '09:35' || now.hm > gateEnd)) { out({ changed: false, skip: '장 시간 아님', et: now }); process.exit(0); }
const cfg = readJSON('data/source.json', null);
if (!cfg || !cfg.bulk) { out({ changed: false, skip: 'data/source.json 없음(가격 출처 미설정)', et: now }); process.exit(0); }

const settings = readJSON('data/settings.json', {});
const live = readJSON('data/live.json', { v: 2, meta: {}, days: [] });
live.meta = live.meta || {};
live.days = live.days || [];
const held = (readJSON('data/held.json', { syms: [] }).syms || []).filter(Boolean);
const todayDone = live.days.find((d) => d.date === today && d.final);
if (todayDone && !FORCE) { out({ changed: false, skip: '오늘 종가 이미 확정', et: now }); process.exit(0); }
const log = { at: new Date().toISOString(), et: `${today} ${now.hm}` };

// 1. universe (refreshed once a day; the screener is a daily list, its prices are not used here)
let uni = readJSON('data/universe.json', null);
if (!uni || uni.date !== today) {
  try {
    const { rows, asof } = await S.screener();
    const next = { date: today, asof, rows: {} };
    for (const [s, r] of rows) {
      if (!(r.cap >= 15e9) || s.includes('^') || (s.includes('/') && s !== 'BRK/B') || BAD_NAME.test(r.name)) continue;
      next.rows[s] = [cleanName(r.name), r.sec || '기타', Math.round(r.cap / 1e9)];
    }
    if (Object.keys(next.rows).length >= 300) { uni = next; writeJSON('data/universe.json', uni); }
    log.screener = Object.keys(next.rows).length;
  } catch (e) {
    log.screenerErr = String(e.message || e).slice(0, 200);
  }
}
if (!uni) {   // fall back to the last day we have
  const last = live.days[live.days.length - 1];
  uni = { date: null, rows: {} };
  if (last) for (const s in last.rows) uni.rows[s] = [(live.meta[s] || [s])[0], (live.meta[s] || [s, '기타'])[1], last.rows[s][2]];
}
const capOf = (s) => (uni.rows[s] ? uni.rows[s][2] : null);
const want = [...new Set([...Object.keys(uni.rows), ...held])];

// 2. prices
const q = new Map();
try {
  const m = await S.quotes(cfg.bulk, want);
  for (const [k, v] of m) q.set(k, v);
  log.bulk = { src: cfg.bulk, asked: want.length, got: m.size };
} catch (e) { log.bulkErr = String(e.message || e).slice(0, 200); }
const heldMissing = held.filter((s) => !q.has(s));
if (heldMissing.length && cfg.held) {
  try { const m = await S.quotes(cfg.held, heldMissing); for (const [k, v] of m) q.set(k, v); log.held = { src: cfg.held, asked: heldMissing.length, got: m.size }; } catch (e) { log.heldErr = String(e.message || e).slice(0, 200); }
}
let idx = null;
if (cfg.index) { try { idx = await S.indexLevel(cfg.index); } catch (e) { log.indexErr = String(e.message || e).slice(0, 200); } }
// Nasdaq 100 and Dow Jones levels for the page's comparison chart; a failure here never stops the collection
const IXS = { ndx: '.NDX', dji: '.DJI' };
let ixNow = null, ixPrev = null;
if (cfg.index) {
  try {
    const m = await S.indexLevels(cfg.index, Object.values(IXS));
    for (const k in IXS) {
      const v = m.get(IXS[k]);
      if (!v) continue;
      if (v.px > 0 && (!v.time || tradeDate(v.time) === today)) (ixNow = ixNow || {})[k] = r2(v.px);
      if (v.prev > 0) (ixPrev = ixPrev || {})[k] = r2(v.prev);
    }
    log.ix = ixNow;
  } catch (e) { log.ixErr = String(e.message || e).slice(0, 200); }
}

let fresh = 0, stale = 0;
const freshQ = new Map();
for (const [s, v] of q) {
  if (!(v && v.px > 0)) continue;
  const td = tradeDate(v.time);
  if (td && td !== today) { stale++; continue; }
  fresh++; freshQ.set(s, v);
}
log.fresh = fresh; log.stale = stale;
{ // how old the quotes are (minutes since each stock's last trade): about 0 means real-time, about 15 means delayed
  const ages = [...freshQ.values()].map((v) => (Date.now() - Date.parse(v.time)) / 60000).filter((a) => Number.isFinite(a)).sort((a, b) => a - b);
  if (ages.length) log.ageMin = Math.round(ages[ages.length >> 1] * 10) / 10;
}
if (fresh < 50 && freshQ.size < Math.max(1, held.length)) {
  log.skip = '새 가격 없음';
  saveLog(); out({ changed: false, ...log }); process.exit(0);
}

let changed = false;
const upsert = (row) => {
  const i = live.days.findIndex((d) => d.date === row.date);
  if (i >= 0) live.days[i] = row; else live.days.push(row);
  live.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  changed = true;
};
for (const s of Object.keys(uni.rows)) if (uni.rows[s][2] >= 20 && !live.meta[s]) live.meta[s] = [uni.rows[s][0], uni.rows[s][1] || '기타'];

// 3. yesterday's official closes when missing or only provisional
const prevDay = prevTradingDay(today);
const prevRow = live.days.find((d) => d.date === prevDay);
if (prevDay > (settings.seedLast || '') && (!prevRow || !prevRow.final)) {
  const rows = {};
  for (const s of want) { const v = q.get(s); if (v && v.prev > 0 && capOf(s) != null) rows[s] = [r2(v.prev), null, capOf(s)]; }
  if (Object.keys(rows).length >= 300) {
    upsert(Object.assign({ date: prevDay, spx: idx && idx.prev > 0 ? r2(idx.prev) : (prevRow && prevRow.spx) || null, rows, src: 'ref', final: true }, ixPrev ? { ix: ixPrev } : {}));
    log.prevFilled = prevDay;
  }
}
// the previous day's Nasdaq 100 and Dow closes, when that day has none yet
{
  const pr = live.days.find((d) => d.date === prevDay);
  if (pr && ixPrev) {
    const add = {};
    for (const k in ixPrev) if (!(pr.ix && pr.ix[k] > 0)) add[k] = ixPrev[k];
    if (Object.keys(add).length) { pr.ix = Object.assign({}, pr.ix || {}, add); changed = true; log.ixPrevFilled = prevDay; }
  }
}

// 4. today's row
const lastClose = (s) => { for (let i = live.days.length - 1; i >= 0; i--) { const d = live.days[i]; if (d.date < today && d.rows[s]) return d.rows[s][0]; } return NaN; };
const rows = {};
for (const s of want) {
  const v = freshQ.get(s);
  if (!v || capOf(s) == null && !held.includes(s)) continue;
  const lc = lastClose(s), pc = lc > 0 ? lc : v.prev;   // our own last close first: some sources roll 'previous close' after the bell
  rows[s] = [r2(v.px), pc > 0 ? Math.round((v.px / pc - 1) * 10000) / 100 : null, capOf(s)];
}
const final = now.hm >= finalFrom && Object.keys(rows).length >= 300;   // a closing row needs the whole list, else retry next run
const idxOk = idx && idx.px > 0 && (!idx.time || tradeDate(idx.time) === today);
const row = { date: today, spx: idxOk ? r2(idx.px) : null, rows, src: 'intraday', t: now.hm, final };
if (ixNow) row.ix = ixNow;
if (final) { upsert(row); log.final = true; } else { writeJSON('data/today.json', row); changed = true; }
log.rows = Object.keys(rows).length;

// every run keeps the prices of the whole list (compact arrays): the engine replays day trades and intraday stops from them
{
  const file = `data/intraday/${today}.json`;
  let doc = readJSON(file, null);
  if (!doc || !Array.isArray(doc.syms)) doc = { date: today, syms: [], snaps: [] };
  const index = new Map(doc.syms.map((s, j) => [s, j]));
  const p = new Array(doc.syms.length).fill(null), h = new Array(doc.syms.length).fill(null);
  for (const [s, v] of freshQ) {
    if (!index.has(s)) { index.set(s, doc.syms.length); doc.syms.push(s); p.push(null); h.push(null); }
    p[index.get(s)] = r2(v.px);
    if (v.hi > 0) h[index.get(s)] = r2(v.hi);          // the day's high so far, from the source
  }
  doc.snaps = doc.snaps.filter((x) => x.t !== now.hm);
  const snap = h.some((x) => x != null) ? { t: now.hm, spx: idxOk ? r2(idx.px) : null, p, h } : { t: now.hm, spx: idxOk ? r2(idx.px) : null, p };
  if (ixNow) snap.ix = ixNow;
  doc.snaps.push(snap);
  // the indexes' previous closes, the base of the page's one-day comparison
  const pv = Object.assign({}, doc.prev || {}, idx && idx.prev > 0 ? { spx: r2(idx.prev) } : {}, ixPrev || {});
  if (Object.keys(pv).length) doc.prev = pv;
  fs.mkdirSync('data/intraday', { recursive: true });
  writeJSON(file, doc);
  log.snap = { t: now.hm, n: freshQ.size, held: held.filter((s) => freshQ.has(s)).length };
  changed = true;
}
if (changed) { live.built = new Date().toISOString(); writeJSON('data/live.json', live); }
log.ms = Date.now() - t0;
saveLog();
out({ changed, ...log });

function saveLog() {
  const L = readJSON('data/collect_log.json', []);
  L.push(log);
  writeJSON('data/collect_log.json', L.slice(-120));
}
