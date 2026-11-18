// Merges the nightly feed (official closes from public evening snapshots, S&P 500 from ravelab/l-etf) into
// data/live.json. A day already closed from our own intraday prices keeps those prices (they are what the account
// traded at); it only receives the official S&P 500 level if it had none.
import fs from 'node:fs';
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const feed = readJSON(process.argv[2], null);
if (!feed || !Array.isArray(feed.days)) { console.log(JSON.stringify({ ok: false, why: 'no feed file' })); process.exit(0); }
const live = readJSON('data/live.json', { v: 2, meta: {}, days: [] });
live.meta = live.meta || {}; live.days = live.days || [];
let added = 0, replaced = 0, spx = 0;
for (const d of feed.days) {
  const i = live.days.findIndex((x) => x.date === d.date);
  const row = { date: d.date, spx: d.spx, rows: d.rows, src: 'feed', final: true };
  if (i < 0) { live.days.push(row); added++; continue; }
  const cur = live.days[i];
  if (!cur.final || !cur.src || cur.src === 'feed' || cur.src === 'ref') { live.days[i] = Object.assign(row, { spx: d.spx != null ? d.spx : cur.spx }, cur.ix ? { ix: cur.ix } : {}); replaced++; }
  else if (cur.spx == null && d.spx != null) { cur.spx = d.spx; spx++; }
}
for (const s in feed.meta || {}) if (!live.meta[s]) live.meta[s] = feed.meta[s];
live.days.sort((a, b) => (a.date < b.date ? -1 : 1));
live.built = new Date().toISOString();
fs.writeFileSync('data/live.json', JSON.stringify(live));
console.log(JSON.stringify({ ok: true, added, replaced, spxFilled: spx, last: live.days.length ? live.days[live.days.length - 1].date : null }));
