// One-off account reset (owner's request, 2026-11-22): the paper account starts again with $1,000,000, every position
// closed at its last price and recorded; the trade records, the learning data and the lab history are kept.
// Usage (once, in the repo):  node tools/reset_account.mjs 1000000 2026-11-20
// It copies every file it changes to data/archive/<today>/ first, and refuses to run twice for the same id.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Dv = require('../deriv.js');
const J = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const W = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));
const capital = +process.argv[2] || 1000000, day = process.argv[3] || '2026-11-20', id = `reset-${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())}`;
const SH = { core: 0.35, deriv: 0.35, crypto: 0.3 };   // stocks 70 (individual stocks 35, derivatives 35) : coins 30
const alloc = J('data/alloc.json', {});
if (alloc.reset && alloc.reset.id === id) { console.log('already reset', id); process.exit(1); }
const arch = `data/archive/${id.slice(6)}`;
fs.mkdirSync(arch, { recursive: true });
for (const f of ['book.json', 'alloc.json', 'settings.json', 'state.json', 'evolution.json', 'deriv/state.json', 'crypto/state.json', 'crypto/view.json'])
  if (fs.existsSync(`data/${f}`) && !fs.existsSync(`${arch}/${f.replace('/', '_')}`)) fs.copyFileSync(`data/${f}`, `${arch}/${f.replace('/', '_')}`);
const S = J('data/state.json', {}), book = J('data/book.json', null), now = Date.now();
// 1. the stock book's live trades, and its open positions closed at their last price, go to the trade archive
const trades = J('data/trades_archive.json', []).concat((book && book.hist && book.hist.trades) || []);
for (const p of (S.account && S.account.open) || []) trades.push({ sym: p.sym, name: p.name, pb: p.pb, dir: p.dir, entryDate: p.entryDate, exitDate: day, entry: p.entry, exit: p.price, qty: p.qty, pnl: p.pnl, R: p.R, reason: '계좌 초기화 정리', reset: id });
W('data/trades_archive.json', trades);
if (fs.existsSync('data/book.json')) fs.unlinkSync('data/book.json');   // a copy is in the archive; the next run opens a fresh book
// 2. settings: the new capital, the book opens on the last final day
const st0 = J('data/settings.json', {});
W('data/settings.json', Object.assign(st0, { capital, bookCapital: Math.round(capital * SH.core), liveStart: day, quietDay: day, resetAt: id }));
// 3. derivatives: positions closed at their marks (recorded), the account starts empty and gets its share by transfer
const d0 = J('data/deriv/state.json', null);
if (d0) {
  const dv = S.deriv || {}, d1 = Dv.init(now, day), rec = [];
  for (const f of dv.fut || []) rec.push({ t: now, kind: 'fut', name: f.name || f.key, pnl: f.pnl, why: '계좌 초기화 정리' });
  for (const o of dv.opt || []) rec.push({ t: now, kind: 'opt', name: o.name, pnl: o.pnl, why: '계좌 초기화 정리' });
  for (const e of dv.els || []) rec.push({ t: now, kind: 'els', name: e.name, pnl: e.pnl, why: '계좌 초기화 정리' });
  for (const k of ['orders', 'fills', 'closed', 'log']) d1[k] = d0[k] || [];
  d1.closed = d1.closed.concat(rec); d1.resetId = id;
  Dv.fund(d1, Math.round(capital * SH.deriv), now, id + '-deriv', `계좌 초기화: 파생 운용에 $${Math.round(capital * SH.deriv).toLocaleString()} 배분`);
  W('data/deriv/state.json', d1);
}
// 4. the allocator: old transfers to the archive, a fresh decision at the next run, the coin job resets itself
alloc.transfers = []; delete alloc.day; delete alloc.brake;
if (alloc.cio) alloc.cio.v = 0;
alloc.reset = { id, at: new Date(now).toISOString(), capital, crypto: Math.round(capital * SH.crypto), why: '사용자 요청: $1,000,000로 계좌 초기화(매매 기록·학습 데이터 유지)' };
W('data/alloc.json', alloc);
// 5. the lab: the shadow accounts were copies of the old account; the history and the bench stay
const ev = J('data/evolution.json', null);
if (ev) { ev.shadows = []; (ev.history = ev.history || []).push({ date: day, type: 'retire', id: 0, kind: 'reset', diff: [], why: '계좌 초기화로 그림자 계좌 다시 시작' }); W('data/evolution.json', ev); }
console.log('reset done', id, 'archive', arch, 'trades kept', trades.length);
