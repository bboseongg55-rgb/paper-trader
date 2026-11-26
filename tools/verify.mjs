// The strategy checks (owner, 2026-11-26: "검증된 것만 매매하고 남은 것들은 백테스팅으로 증명 후에 매매"). Every method
// of every part is run alone over all the history there is, with its fees and slippage, and passes only if
//   1. it made at least 30 closed trades (10 in each half of the period),
//   2. its average result per unit of risk (R) and its dollar profit are both above zero over the whole period,
//   3. and both are above zero in the first half and in the second half on their own.
// What passes trades with its fixed rules; what fails or cannot be tested does not open new trades, and is checked
// again with the new data every night (the coin checks whenever their history is refreshed). Overlays (the hedge,
// leverage, the softer loss brakes) are kept only if the verified methods together do better with them in both halves.
// Writes data/verify.json; run.mjs calls run() every evening, `node tools/verify.mjs` runs it by hand.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(ROOT + f, 'utf8')); } catch { return d; } };
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(ROOT + f)));
const r3 = (v) => Math.round(v * 1000) / 1000;

export const VERSION = 2;   // 2: the long record (2009 on) when data/hist has it
export const RULE = '30건 이상(전반·후반 각 10건 이상), 수수료·슬리피지를 뺀 평균 R과 손익이 전체·전반·후반 모두 0보다 큼';
function stat(xs) {
  const n = xs.length, m = n ? xs.reduce((a, x) => a + x.R, 0) / n : 0, sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x.R - m) ** 2, 0) / (n - 1)) : 0;
  const pos = xs.filter((x) => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), neg = -xs.filter((x) => x.pnl < 0).reduce((a, x) => a + x.pnl, 0);
  return { n, avgR: r3(m), t: sd > 0 ? Math.round((m / sd) * Math.sqrt(n) * 100) / 100 : 0, pnl: Math.round(pos - neg), win: n ? Math.round((xs.filter((x) => x.pnl > 0).length / n) * 100) : 0, pf: neg > 0 ? Math.round((pos / neg) * 100) / 100 : null };
}
// trades [{at: sortable time or date, R, pnl}] split at the period's middle
function judge(trades, a, b) {
  const mid = typeof a === 'number' ? a + (b - a) / 2 : null;
  let split;
  if (mid != null) split = mid; else { const ds = trades.map((x) => x.at).sort(); split = a && b ? midDate(a, b) : ds[Math.floor(ds.length / 2)]; }
  const all = stat(trades), h1 = stat(trades.filter((x) => x.at < split)), h2 = stat(trades.filter((x) => x.at >= split));
  const pass = all.n >= 30 && h1.n >= 10 && h2.n >= 10 && all.avgR > 0 && h1.avgR > 0 && h2.avgR > 0 && all.pnl > 0 && h1.pnl > 0 && h2.pnl > 0;
  const why = all.n < 30 || h1.n < 10 || h2.n < 10 ? `표본 부족(${all.n}건, 전반 ${h1.n}·후반 ${h2.n})`
    : !(all.avgR > 0 && all.pnl > 0) ? '전체 기간 손실' : !(h1.avgR > 0 && h1.pnl > 0) ? '전반 손실' : !(h2.avgR > 0 && h2.pnl > 0) ? '후반 손실' : '통과';
  return { all, h1, h2, pass, why, split: typeof split === 'number' ? new Date(split).toISOString().slice(0, 10) : split };
}
function midDate(a, b) { return new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString().slice(0, 10); }
const item = (k, book, name, family, data, j, extra) => Object.assign({ k, book, name, family, data }, j || {}, extra || {});
const untested = (k, book, name, family, why) => ({ k, book, name, family, data: null, pass: false, why, untested: true });

// ── 0. the long record (tools/fetch_long.mjs, owner 2026-11-26: "과거 데이터 확장"): CNBC's daily closes (split adjusted) from
// mid-2009 spliced onto the book's own data at its first day (each stock scaled so both agree there), the S&P 500 index
// the same way; before 2024 a stock may be bought only on days it was in the S&P 500 (the point-in-time list), so the
// test does not pick today's winners in advance. Stocks that left the market are not on CNBC and are missing, so
// some survivor bias stays (확인필요). The bond part gets the US Treasury yields from FRED and the bond funds' closes (without
// their payouts, so on the low side) before 2024; the other countries' bonds start in 2024 as before.
// which long record the checks used: a new one (tools/fetch_long.mjs) means checking again
export function longKey() { const m = readJSON('data/hist/meta_long.json', null), c = readJSON('data/hist/meta.json', null); return m || c ? `${(m && m.built) || ''}|${(c && c.built) || ''}` : null; }
export function longParts() {
  const g = (f) => { try { return gz(f); } catch { return null; } };
  const Y = g('data/hist/long_stocks.json.gz'), M = g('data/hist/sp500_members.json.gz'), X = g('data/hist/long_misc.json.gz'), F = g('data/hist/fred_rates.json.gz');
  // the stocks only once the fetch got through its whole list (a part of it would be the list cut at some letter)
  const stocks = !!(Y && Y.s && M && M.rows && !(Y.pending > 0));
  return stocks || X ? { Y: stocks ? Y : null, M, X: X || {}, F, stocks } : null;
}
const ynorm = (s) => String(s).toUpperCase().replace(/[./]/g, '-');
export function longSeed(seed, P) {
  const d0 = seed.dates[0], cal = P.Y.dates, at = new Map(cal.map((d, i) => [d, i]));
  const hd = cal.filter((d) => d >= '2009-06-01' && d < d0);
  const ix = (sym, d) => { const r = P.Y.s[sym]; if (!r) return NaN; const i = at.get(d); if (i == null || i < r[0]) return NaN; const v = r[1][i - r[0]]; return v > 0 ? v : NaN; };
  // the S&P 500 list on each historical day
  const rows = (P.M && P.M.rows) || [], sets = rows.map((r) => new Set(r[1].split(',')));
  let k = -1; const memb = hd.map((d) => { while (k + 1 < rows.length && rows[k + 1][0] <= d) k++; return k >= 0 ? sets[k] : null; });
  const scaleAt = (sym, c) => { for (let t = 0; t < seed.dates.length && t < 60; t++) { const a = c[t], b = ix(sym, seed.dates[t]); if (a > 0 && b > 0) return a / b; } return null; };
  const syms = seed.syms.map((x) => {
    const y = ynorm(x.s), f = scaleAt(y, x.c);
    const c = hd.map((d) => (f ? ix(y, d) * f : NaN)), e = hd.map((d, i) => (memb[i] && memb[i].has(y) && c[i] > 0 ? '1' : '0')).join('');
    return Object.assign({}, x, { c: c.map((v) => (v > 0 ? +v.toPrecision(7) : null)).concat(x.c), e: e + x.e });
  });
  // past members the book does not track: their own closes up to March 2024, never bought after September 2023
  const own = new Set(seed.syms.map((x) => ynorm(x.s)));
  for (const y of Object.keys(P.Y.s)) {
    if (own.has(y)) continue;
    const c = hd.map((d) => ix(y, d)), e = hd.map((d, i) => (d < '2023-10-01' && memb[i] && memb[i].has(y) && c[i] > 0 ? '1' : '0')).join('');
    if (!e.includes('1')) continue;
    const tail = seed.dates.map((d) => { const v = ix(y, d); return v > 0 ? v : null; });
    syms.push({ s: y, n: y, sec: '기타', c: c.map((v) => (v > 0 ? v : null)).concat(tail), e: e + '0'.repeat(seed.dates.length) });
  }
  const gs = P.X['.SPX'] || {}, fs = seed.spx[0] > 0 && gs[d0] > 0 ? seed.spx[0] / gs[d0] : 1;
  return Object.assign({}, seed, { dates: hd.concat(seed.dates), spx: hd.map((d) => (gs[d] > 0 ? +(gs[d] * fs).toFixed(2) : null)).concat(seed.spx), syms });
}
export function longBonds(bondsHist, P) {
  const B = JSON.parse(JSON.stringify(bondsHist || { y: {}, etf: {}, fx: {}, div: {} })), first = (o) => Object.keys(o || {}).sort()[0] || '9999';
  for (const [k, id] of [['US2Y', 'DGS2'], ['US5Y', 'DGS5'], ['US10Y', 'DGS10'], ['US30Y', 'DGS30']]) {
    const h = (B.y[k] = B.y[k] || {}), f0 = first(h);
    for (const [d, v] of Object.entries((P.F && P.F[id]) || {})) if (d >= '2009-01-01' && d < f0) h[d] = v;
  }
  B.div = B.div || {};
  for (const k of Object.keys(B.etf || {})) {
    const h = B.etf[k], f0 = first(h), y = P.X[k] || {};
    if (!(h[f0] > 0) || !(y[f0] > 0)) continue;
    const f = h[f0] / y[f0];
    for (const [d, v] of Object.entries(y)) if (d >= '2009-01-01' && d < f0) h[d] = +(v * f).toPrecision(7);
    // and their payouts before the book's own record (tools/fetch_long.mjs from Nasdaq), on the same scale
    const pre = ((P.X.div && P.X.div[k]) || []).filter(([d]) => d >= '2009-01-01' && d < f0).map(([d, a]) => [d, +(a * f).toPrecision(6)]);
    B.div[k] = pre.concat(B.div[k] || []);
  }
  return B;
}
// the futures, the coins' spot and the rates for the futures and basis checks: CNBC's continuous front month before
// the book's own record (the same series), FRED's rates before 2024
export function longMS(MS, P) {
  const out = Object.assign({}, MS);
  const put = (key, src) => { const h = Object.assign({}, src || {}), m = MS[key] || {}, f0 = Object.keys(m).sort()[0] || '9999'; for (const d of Object.keys(h)) if (d >= f0) delete h[d]; out[key] = Object.assign(h, m); };
  // the long file keeps CNBC's own symbols, the same as the book's record
  for (const k of ['@SP.1', '@ND.1', '@DJ.1', '@TFS.1', '@TU.1', '@FV.1', '@TY.1', '@US.1', '@CL.1', '@GC.1', '@SI.1', '@HG.1', '@BTC.1', '@ETH.1', 'BTC.CM=', 'ETH.CM=', '.SPX', '.VIX']) if (P.X[k]) put(k, P.X[k]);
  for (const [k, id] of [['US1M', 'DGS1MO'], ['US3M', 'DGS3MO'], ['US2Y', 'DGS2'], ['US5Y', 'DGS5'], ['US10Y', 'DGS10'], ['US30Y', 'DGS30']]) if (P.F && P.F[id]) put(k, P.F[id]);
  return out;
}

// ── 1. the stock and bond book (engine.js): each method alone, fixed rules, no account brakes
export function stockChecks(E, D, toI) {
  const from = 210, to = toI != null ? toI : D.dates.length - 1, a = D.dates[from], b = D.dates[to], out = [];
  const base = { from, to, capital: 1000000, params: E.DEFAULTS, adaptive: false, log: false, force: { lev: 1, regimeLevel: 0, shortAny: 1 }, hedgeFlex: 1, chart: 1, chartExit: 0, asym: 1, mom: 1 };
  const NAMES = { bo: ['신고가 돌파', 'breakout'], pb: ['추세 눌림목(RSI 2 과매도)', 'meanrev'], dt: ['당일 단타', 'breakout'], bd: ['채권 추세', 'trend'], sb: ['하락 돌파 공매도', 'breakout'], ch: ['차트 저항 돌파', 'breakout'], cs: ['차트 지지 이탈 공매도', 'breakout'], mo: ['모멘텀(12-1개월)', 'momentum'] };
  for (const k of Object.keys(NAMES)) {
    const r = E.simulate(D, Object.assign({}, base, { only: k, brakes: false }));
    const tr = (r.trades || []).filter((x) => x.pb === k && Number.isFinite(x.R)).map((x) => ({ at: x.exitDate, R: x.R, pnl: x.pnl }));
    out.push(item(k, 'stock', NAMES[k][0], NAMES[k][1], `${a}~${b} 일봉, ${D.S.length}종목${a < '2024' ? '(2024년 전에는 그때 S&P 500에 들어 있던 종목만 매수)' : ''}`, judge(tr, a, b)));
  }
  return out;
}
// the verified stock methods together: does an overlay help in both halves? (Sharpe ratio of the daily account value)
export function stockOverlays(E, D, allow, toI) {
  const from = 210, to = toI != null ? toI : D.dates.length - 1, midI = Math.floor((from + to) / 2);
  const met = (eq) => { const r = eq.slice(1).map((v, i) => v / eq[i] - 1), m = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1)); let pk = -Infinity, dd = 0; for (const v of eq) { pk = Math.max(pk, v); dd = Math.max(dd, 1 - v / pk); } return { ret: r3(eq[eq.length - 1] / eq[0] - 1), mdd: r3(dd), sharpe: sd > 0 ? Math.round((m / sd) * Math.sqrt(252) * 100) / 100 : 0 }; };
  const run = (o) => {
    const r = E.simulate(D, Object.assign({ from, to, capital: 1000000, params: E.DEFAULTS, adaptive: false, log: false, hedgeFlex: 1, chart: 1, chartExit: 0, asym: 1, mom: 1 }, o));
    const eq = r.equity.map((e) => e.eq), k = r.equity.findIndex((e) => e.date >= D.dates[midI]), bench = r.equity.map((e) => e.bench);
    return { all: met(eq), h1: met(eq.slice(0, k + 1)), h2: met(eq.slice(k)), bench: { all: met(bench), h1: met(bench.slice(0, k + 1)), h2: met(bench.slice(k)) } };
  };
  const cfg = { lev: 1, brakes: 'emergency', hedge: false };
  if (!allow.length) return { cfg, tests: [], keep: [] };
  const F1 = { lev: 1, regimeLevel: 0, shortAny: 1 };
  // the methods together: a method that passed alone stays only if the book does no better without it in both halves
  // (one method can crowd the others out of the money); checked again after each removal
  let S = allow.slice(), baseRes = run({ allow: S, brakes: 'emergency', force: F1 });
  const drops = [];
  for (let again = true; again && S.length > 1;) {
    again = false;
    for (const m of S) {
      const w = run({ allow: S.filter((x) => x !== m), brakes: 'emergency', force: F1 });
      if (w.h1.sharpe > baseRes.h1.sharpe && w.h2.sharpe > baseRes.h2.sharpe) { drops.push({ k: m, with: baseRes, without: w }); S = S.filter((x) => x !== m); baseRes = w; again = true; break; }
    }
  }
  allow = S;
  const better = (x) => x.h1.sharpe > baseRes.h1.sharpe && x.h2.sharpe > baseRes.h2.sharpe;
  const tests = [{ k: 'base', name: '검증된 방법만(레버리지 1배, 비상 손절만)', res: baseRes, keep: true }];
  const hedge = run({ allow: allow.concat(['hedge']), brakes: 'emergency', force: { lev: 1, regimeLevel: 0, shortAny: 1 } });
  tests.push({ k: 'hedge', name: '하락 대비 헷지 추가', res: hedge, keep: better(hedge) }); cfg.hedge = better(hedge);
  const lev = run({ allow, brakes: 'emergency', force: { lev: 1.5, regimeLevel: 0, shortAny: 1 } });
  tests.push({ k: 'lev', name: '레버리지 1.5배', res: lev, keep: better(lev) }); if (better(lev)) cfg.lev = 1.5;
  const brakes = run({ allow, brakes: 'all', force: { lev: 1, regimeLevel: 0, shortAny: 1 } });
  tests.push({ k: 'brakes', name: '손실 브레이크 전부(−2.5%/일, −8% 절반, 연패 축소)', res: brakes, keep: better(brakes) }); if (better(brakes)) cfg.brakes = 'all';
  return { cfg, tests, keep: S, drops, window: `${D.dates[from]}~${D.dates[to]}`, split: D.dates[midI] };
}

// ── 2. the futures trend book (deriv.js nightly) replayed: front-month closes, carry charged daily, rolls costed
const DIV = { MES: 0.013, MNQ: 0.007, MYM: 0.018, M2K: 0.013 }, YLD = { ZT: 'US2Y', ZF: 'US5Y', ZN: 'US10Y', ZB: 'US30Y' }, CYCLE = { MCL: 21, MBT: 21, MET: 21, MGC: 42, SIL: 42, MHG: 42 };
function lastOnF(MS) { const cache = {}; return (k, d) => { const s = MS[k] || {}, ks = (cache[k] = cache[k] || Object.keys(s).sort()); let lo = 0, hi = ks.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ks[m] <= d) { r = m; lo = m + 1; } else hi = m - 1; } return r >= 0 ? +s[ks[r]] : null; }; }
function lastFriday(y, m) { const x = new Date(Date.UTC(y, m + 1, 0)); while (x.getUTCDay() !== 5) x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }
export function ctaCheck(Dv, MS) {
  const lastOn = lastOnF(MS), dates = Object.keys(MS['@SP.1'] || {}).sort().slice(130);   // 130 days to warm the trend measures
  if (dates.length < 200) return untested('cta', 'deriv', '선물 추세(14개 시장)', 'trend', '선물 이력 부족');
  const basis = (sk, fk, d) => { const F = lastOn(fk, d), S = lastOn(sk, d); if (!(F > 0 && S > 0)) return 0.08; const t = new Date(d + 'T00:00:00Z'); let e = lastFriday(t.getUTCFullYear(), t.getUTCMonth()); if (Date.parse(e) - t < 2 * 864e5) e = lastFriday(t.getUTCFullYear(), t.getUTCMonth() + 1); return Math.max(-0.3, Math.min(0.4, (F / S - 1) / (Math.max(3, (Date.parse(e) - t) / 864e5) / 365))); };
  const carry = (k, d) => { const r = (lastOn('US3M', d) || 4) / 100; if (DIV[k] != null) return r - DIV[k]; if (YLD[k]) return r - (lastOn(YLD[k], d) || 4) / 100; if (k === 'MBT') return basis('BTC.CM=', '@BTC.1', d); if (k === 'MET') return basis('ETH.CM=', '@ETH.1', d); return r; };
  const st = Dv.init(Date.parse(dates[0] + 'T21:00:00Z'), dates[0]);
  Dv.fund(st, 1000000, Date.parse(dates[0] + 'T21:00:00Z'), 'bt', 'backtest');
  const risk0 = {}, held = {}, trades = []; let prev = null, nC = 0;
  for (const d of dates) {
    const now = Date.parse(d + 'T21:00:00Z'), fut = {};
    for (const f of Dv.FUT) { const px = MS[f.cnbc + '.1'] && MS[f.cnbc + '.1'][d]; if (px > 0) fut[f.key] = { c1: { contract: 'C', px: +px, settle: +px, settleDate: d, exp: '2099-12-31' } }; }
    if (prev) {
      const days = (Date.parse(d) - Date.parse(prev)) / 864e5;
      for (const k of Object.keys(st.fut)) {
        const p = st.fut[k], f = Dv.FUT_BY[k], c = carry(k, prev) * p.qty * f.mult * p.mark * days / 365;
        st.cash -= c; p.real = (p.real || 0) - c; held[k] = (held[k] || 0) + 1;
        if (held[k] % (CYCLE[k] || 63) === 0) { const fee = 2 * (Dv.CFG.futComm + Dv.CFG.nfa + f.xfee + f.mult * f.tick) * Math.abs(p.qty); st.cash -= fee; p.real -= fee; }
      }
    }
    Dv.nightly(st, { date: d, now, account: Dv.equity(st), rp: lastOn('US1M', d), hist: MS, fut, chain: null, allow: ['cta'], cio: { fut: { budget: 0.06, tilt: {} }, els: { on: false } } });
    for (const x of st.closed.slice(nC)) if (x.kind === 'fut' && x.s === 'cta') trades.push({ at: x.to, R: risk0[x.key] && risk0[x.key].from === x.from ? x.pnl / risk0[x.key].risk : 0, pnl: x.pnl });
    nC = st.closed.length;
    for (const k of Object.keys(st.fut)) if (!risk0[k] || risk0[k].from !== st.fut[k].date) { const s = st.signals[k]; risk0[k] = { from: st.fut[k].date, risk: Dv.CFG.cta.stopK * (s ? s.vol : 0.01) * st.fut[k].entry * Dv.FUT_BY[k].mult * Math.abs(st.fut[k].qty) }; held[k] = 0; }
    prev = d;
  }
  return item('cta', 'deriv', '선물 추세(14개 시장)', 'trend', `${dates[0]}~${dates[dates.length - 1]} 선물 일봉(보유 비용 반영)`, judge(trades, dates[0], dates[dates.length - 1]));
}
// ── 3. rates: the 2s10s curve trade (Treasury yields since 1990, FRED, then the recent days), and the bitcoin basis
export function curveTrades(y2, y10, r3m, o) {
  const P = Object.assign({ look: 63, enter: 0.15, stopBp: 25, K: 200, D2: 1.9, D10: 8.0, cost: 1.0 }, o || {});
  const dates = Object.keys(y2).filter((d) => y10[d] != null).sort(), sl = dates.map((d) => y10[d] - y2[d]), trades = [];
  const rOn = lastOnF({ r: r3m });
  let pos = null;
  for (let i = P.look; i < dates.length; i++) {
    const d = dates[i], s = sl[i], ds = s - sl[i - P.look];
    if (pos) {
      const dy = (s - sl[i - 1]) * 100, r = (rOn('r', d) || 4) / 100, days = (Date.parse(d) - Date.parse(dates[i - 1])) / 864e5;
      const n2 = P.K / (P.D2 * 1e-4), n10 = P.K / (P.D10 * 1e-4), carry = pos.side * (n2 * (y2[d] / 100 - r) - n10 * (y10[d] / 100 - r)) * days / 365;
      pos.pnl += pos.side * P.K * dy + carry; pos.days++;
      if (pos.days % 63 === 0) pos.pnl -= 0.5 * P.K * P.cost;
      const adverse = pos.side * (s - pos.s0) * 100, why = adverse <= -P.stopBp ? 'stop' : Math.sign(ds) === -pos.side ? 'turn' : null;
      if (why) { pos.pnl -= (P.K * P.cost) / 2; trades.push({ at: d, from: pos.d0, side: pos.side, R: pos.pnl / (P.K * P.stopBp), pnl: pos.pnl, why }); pos = null; }
    }
    if (!pos && Math.abs(ds) >= P.enter) pos = { side: Math.sign(ds), s0: s, d0: d, pnl: (-P.K * P.cost) / 2, days: 0 };
  }
  return { trades, dates, open: pos };
}
export function curveCheck(MS) {
  let F = null; try { F = gz('data/hist/fred_rates.json.gz'); } catch { /* no long history yet */ }
  const join = (a, b) => Object.assign({}, a || {}, b || {});
  const y2 = join(F && F.DGS2, MS.US2Y), y10 = join(F && F.DGS10, MS.US10Y), r3m = join(F && F.DGS3MO, MS.US3M);
  const { trades, dates } = curveTrades(y2, y10, r3m);
  const j = judge(trades, dates[63], dates[dates.length - 1]), recent = stat(trades.filter((x) => x.at >= '2024-01-01'));
  return item('curve', 'deriv', '장단기 금리차(2년·10년) 추세, 듀레이션 중립', 'carry', `${dates[63]}~${dates[dates.length - 1]} 미국 국채 금리(FRED·일봉)`, j, { recent });
}
export function basisCheck(MS) {
  const lastOn = lastOnF(MS), dates = Object.keys(MS['@BTC.1'] || {}).filter((d) => MS['BTC.CM='] && MS['BTC.CM='][d] != null).sort(), trades = [], notional = 100000;
  let i = 0;
  while (i >= 0 && i < dates.length) {
    const d = dates[i], t = new Date(d + 'T00:00:00Z'); let exp = lastFriday(t.getUTCFullYear(), t.getUTCMonth()); if (Date.parse(exp) - Date.parse(d) < 5 * 864e5) exp = lastFriday(t.getUTCFullYear(), t.getUTCMonth() + 1);
    const F = +MS['@BTC.1'][d], S = +MS['BTC.CM='][d], S1 = lastOn('BTC.CM=', exp), days = (Date.parse(exp) - Date.parse(d)) / 864e5;
    if (!(F > 0 && S > 0 && S1 > 0) || exp > dates[dates.length - 1]) break;
    const q = notional / S, r = (lastOn('US1M', d) || 4) / 100 - 0.0025, prem0 = (F / S - 1) * 365 / days;
    if (!(prem0 > r)) { i = dates.findIndex((x) => x > exp); continue; }   // a premium under the RP rate: the dollars stay in RP
    const pnl = q * (F - S1) + q * (S1 - S) - notional * 0.0002 * 2 - Math.ceil(q / 0.1) * 2 * (0.75 + 0.02 + 2.5 + 0.5) - notional * r * days / 365;
    trades.push({ at: exp, R: pnl / (notional * 0.02), pnl, prem: (F / S - 1) * 365 / days });
    i = dates.findIndex((x) => x > exp);
  }
  if (!trades.length) return untested('basis', 'deriv', '비트코인 현·선물 차익(베이시스)', 'carry', '자료 없음');
  return item('basis', 'deriv', '비트코인 현·선물 차익(베이시스): 선물 프리미엄이 RP 금리보다 높을 때 현물 매수 + CME 선물 매도', 'carry', `${dates[0]}~${dates[dates.length - 1]} CME 비트코인 선물·기준가격(일봉), RP 이자를 뺀 초과수익`, judge(trades, dates[0], dates[dates.length - 1]),
    { premium: r3(trades.reduce((a, x) => a + x.prem, 0) / trades.length), per: '$100,000당' });
}
// ── 4. coins: a strategy alone replayed through crypto.js step() over Coinbase history (hourly bars sampled 20 times,
// minute bars 4 times, as the loop polls; a 1bp half-spread; the trade tape between polls for market making)
export function cryptoReplay(C, gran, only, rule) {
  const keep = { arb: C.CFG.arbShare, b: Object.assign({}, C.CFG.brakes) };
  C.CFG.arbShare = 0; C.CFG.brakes.day = 9; C.CFG.brakes.stop = 9; C.CFG.brakes.half = 9;
  try {
    const H = Object.fromEntries(C.COINS.map((c) => [c, new Map(gz(`data/hist/cb_${c}_1${gran}.json.gz`).map((r) => [r[0], r]))]));
    const times = [...new Set(C.COINS.flatMap((c) => [...H[c].keys()]))].sort((a, b) => a - b);   // each coin from its first candle
    let FD = {}; try { FD = gz('data/hist/hl_funding.json.gz'); } catch { /* no funding record: the assumed rate */ }
    const fk = Object.fromEntries(C.COINS.map((c) => [c, 0])), fund = {};
    const step = gran === 'h' ? 3600e3 : 60e3, NP = gran === 'h' ? 20 : 4, hs = 0.0001;
    const book = (px) => { const b = {}; for (const v of Object.keys(C.VENUES)) { b[v] = {}; for (const c of Object.keys(px)) b[v][c] = { bid: px[c] * (1 - hs), ask: px[c] * (1 + hs) }; } return b; };
    const p0 = Object.fromEntries(C.COINS.filter((c) => H[c].has(times[0])).map((c) => [c, H[c].get(times[0])[1]]));
    const st = C.init(1000000, { at: times[0], books: book(p0), toks: {} }, times[0]), rows = [];
    st.only = only; st.onClose = (r) => rows.push(r);
    if (rule) st.sv = { pos: {}, done: [], live: rule, at: 9e15, seeded: true };
    let prev = Object.assign({}, p0), prevAt = times[0];
    for (const t of times) {
      const pathN = {};
      for (const c of C.COINS) { const r = H[c].get(t); if (!r) continue; const [, o, h, l, cl] = r, k4 = cl >= o ? [o, l, h, cl] : [o, h, l, cl], pts = []; for (let j = 0; j < NP; j++) { const x = (j / NP) * 3, sg = Math.min(2, Math.floor(x)); pts.push(k4[sg] + (k4[sg + 1] - k4[sg]) * (x - sg)); } pts.push(cl); pathN[c] = pts; }
      for (const c of C.COINS) { const L = FD[c] || []; while (fk[c] < L.length && L[fk[c]][0] <= t) fund[c] = L[fk[c]++][1]; }
      C.setExt({ fund });
      for (let j = 0; j < NP; j++) {
        const at = t + (j * step) / NP, px = {}, tape = {};
        for (const c of Object.keys(pathN)) { px[c] = j === NP - 1 ? pathN[c][NP] : pathN[c][j]; const pv = prev[c] > 0 ? prev[c] : px[c]; tape[c] = { lo: Math.min(pv, px[c]), hi: Math.max(pv, px[c]), n: 1, from: prevAt }; }
        C.step(st, { at, books: book(px), toks: {}, tape }, at);
        Object.assign(prev, px); prevAt = at;
      }
    }
    const tr = rows.filter((r) => r.s === only).map((r) => ({ at: r.t, R: r.R, pnl: r.pnl }));
    return { j: judge(tr, times[0], times[times.length - 1]), from: new Date(times[0]).toISOString().slice(0, 10), to: new Date(times[times.length - 1]).toISOString().slice(0, 10) };
  } finally { C.CFG.arbShare = keep.arb; Object.assign(C.CFG.brakes, keep.b); C.setExt({}); }
}
export function cryptoChecks(C, prev) {
  const meta = readJSON('data/hist/meta.json', null);
  if (!meta) return [untested('c_trend', 'crypto', '코인 추세(20시간 돌파)', 'trend', '과거 시세 없음')];
  const code = crypto.createHash('sha1').update(fs.readFileSync(ROOT + 'crypto.js')).digest('hex').slice(0, 12), key = `${meta.built}|${code}`;
  const old = prev && prev.cryptoKey === key ? (prev.items || []).filter((x) => x.book === 'crypto') : null;
  if (old && old.length) return old;
  const out = [];
  const add = (k, name, family, gran, only, rule) => { const r = cryptoReplay(C, gran, only, rule); out.push(item(k, 'crypto', name, family, `${r.from}~${r.to} Coinbase ${gran === 'h' ? '1시간봉' : '1분봉'}, 무기한 선물은 하이퍼리퀴드 실제 펀딩비(2023년 5월부터, 그 전은 연 8% 가정)`, r.j)); };
  add('c_trend', '코인 추세(20시간 신고가·신저가 돌파, 무기한 선물 양방향)', 'trend', 'h', 'trend');
  add('c_mr', '코인 평균회귀(20시간 평균에서 2 표준편차)', 'meanrev', 'h', 'mr');
  for (const [k, v] of Object.entries(C.CFG.scalpV)) add('c_scalp:' + k, `코인 초단타: ${v.name}`, k === 'fade' ? 'meanrev' : 'breakout', 'm', 'scalp', k);
  add('c_mm', '코인 시장 조성(호가 양쪽 제시)', 'mm', 'm', 'mm');
  out.push(untested('c_tok', 'crypto', '토큰화 주식 추세(크라켄, 24시간)', 'trend', '과거 시세가 30일(720시간)뿐이라 표본 부족'));
  out.push(untested('c_arb', 'crypto', '거래소 간 차익', 'carry', '과거 거래소별 호가 자료가 없어 백테스트 불가'));
  out.forEach((x) => { x.cryptoKey = key; });
  return out;
}
export function rpOf(MS) {
  return (dates) => { const y = MS.US1M || {}, ks = Object.keys(y).sort(); let j = 0, last = null; return dates.map((d) => { while (j < ks.length && ks[j] <= d) last = y[ks[j++]]; return last == null ? null : Math.max(0, last - 0.25) / 100; }); };
}
export function run(o) {
  const E = o.E, Dv = o.Dv, C = o.C, prev = readJSON('data/verify.json', null), t0 = Date.now();
  // the long record when it is there (else the book's own two years)
  const P = o.seed && o.Bonds ? longParts() : null;
  let D = o.D, MS = o.MS, to = o.to, span = 'book';
  if (P) {
    MS = longMS(o.MS, P);
    span = 'futures';   // the futures and coins on the long record, the stocks still on the book's two years
    if (P.stocks) {
      const LB = longBonds(o.bondsHist, P);
      D = E.prepare(longSeed(o.seed, P), o.L, {}, { instruments: (dates) => o.Bonds.build(LB, o.L.days, dates), rp: rpOf(MS) });
      to = o.lastFinal ? D.dates.lastIndexOf(o.lastFinal) : D.dates.length - 1; if (to < 0) to = D.dates.length - 1;
      span = 'long';
    }
  }
  const items = [];
  items.push(...stockChecks(E, D, to));
  const passStock = items.filter((x) => x.book === 'stock' && x.pass).map((x) => x.k);
  const ov = stockOverlays(E, D, passStock, to), allowStock = ov.keep || [];
  for (const d of ov.drops || []) { const x = items.find((y) => y.k === d.k); if (x) { x.pass = false; x.soloPass = true; x.why = `혼자서는 통과했지만 다른 검증된 방법과 함께 돌리면 빼는 편이 전반·후반 모두 나음(샤프 지수 ${d.with.h1.sharpe}→${d.without.h1.sharpe}, ${d.with.h2.sharpe}→${d.without.h2.sharpe})`; } }
  items.push({ k: 'hedge', book: 'stock', name: '하락 대비 헷지(국채·경기방어주·인버스)', family: 'hedge', data: ov.window, pass: ov.cfg.hedge, why: ov.cfg.hedge ? '검증된 방법과 함께 전반·후반 모두 샤프 지수 개선' : '검증된 방법과 함께 돌리면 전반·후반 중 한쪽 이상에서 샤프 지수가 나빠짐', overlay: true });
  items.push(ctaCheck(Dv, MS));
  items.push(curveCheck(MS));
  items.push(basisCheck(MS));
  items.push(...cryptoChecks(C, prev));
  items.push(untested('opt', 'deriv', '옵션(풋·콜 스프레드, 커버드콜, 현금 담보 풋, 옵션 매수)', 'carry', '과거 옵션 호가 자료가 없어 백테스트 불가(모형 가격만으로는 검증으로 보지 않음)'));
  items.push(untested('els', 'deriv', 'ELS(지수 연계 증권)', 'carry', '6개월마다 관찰하는 상품이라 2년 자료로는 표본 부족'));
  items.push({ k: 'rp', book: 'all', name: '현금 RP(1개월 국채 금리 − 0.25%p)', family: 'carry', data: '매일 정산', pass: true, why: '원금 손실 위험이 없는 이자', riskFree: true });
  const allow = {
    stock: allowStock.concat(ov.cfg.hedge ? ['hedge'] : []),
    deriv: items.filter((x) => x.book === 'deriv' && x.pass).map((x) => x.k),
    crypto: items.filter((x) => x.book === 'crypto' && x.pass).map((x) => x.k.replace(/^c_/, '')),
  };
  // the basis trade has its spot leg in the coin part
  if (allow.deriv.includes('basis')) allow.crypto.push('basis');
  const out = { v: VERSION, built: new Date().toISOString(), rule: RULE, span, longKey: longKey(), ms: Date.now() - t0, cfg: ov.cfg, overlays: ov, allow, items, cryptoKey: (items.find((x) => x.cryptoKey) || {}).cryptoKey || null };
  return out;
}
// by hand: node tools/verify.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const E = require(ROOT + 'engine.js'), Bonds = require(ROOT + 'bonds.js'), Dv = require(ROOT + 'deriv.js'), C = require(ROOT + 'crypto.js');
  const seed = readJSON('data/seed.json'), live = readJSON('data/live.json', { days: [] });
  const bondsHist = readJSON('data/bonds_hist.json', null), MS = (readJSON('data/macro_hist.json', null) || {}).s || {};
  const rpFor = (dates) => { const y = MS.US1M || {}, ks = Object.keys(y).sort(); let j = 0, last = null; return dates.map((d) => { while (j < ks.length && ks[j] <= d) last = y[ks[j++]]; return last == null ? null : Math.max(0, last - 0.25) / 100; }); };
  const L = Object.assign({}, live, { days: (live.days || []).filter((d) => d.final !== false) });
  const D = E.prepare(seed, L, {}, { instruments: bondsHist ? (dates) => Bonds.build(bondsHist, L.days, dates) : null, rp: rpFor });
  const out = run({ E, D, MS, Dv, C, seed, L, Bonds, bondsHist });
  fs.writeFileSync(ROOT + 'data/verify.json', JSON.stringify(out, null, 1) + '\n');
  for (const x of out.items) console.log(x.pass ? 'PASS' : 'fail', x.k.padEnd(14), x.all ? `n ${x.all.n} R ${x.all.avgR} $${x.all.pnl} | ${x.why}` : x.why);
  console.log('allow', JSON.stringify(out.allow), 'cfg', JSON.stringify(out.cfg), 'sec', Math.round(out.ms / 1000));
}
