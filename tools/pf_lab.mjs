// Portfolio lab: compares standard, fixed-parameter portfolio rules with simply holding the S&P 500 on the saved daily
// history (data/macro_hist.json). Reads data/ only and writes nothing. Run it in a copy:
//   node tools/pf_lab.mjs            → table
//   node tools/pf_lab.mjs --json     → JSON (for data/rd.json)
// Every rule decides its weights at the close of day t from data up to t and earns day t+1's return (no look-ahead).
// Index returns are price only (no dividends) for every rule and the benchmark alike. Cash earns the 3-month bill.
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync('data/macro_hist.json', 'utf8')).s || {};
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const COST = 0.0002;             // trading cost per unit of weight traded (futures/ETF, 확인필요)
const LAM = 0.94;                // RiskMetrics EWMA decay for daily variance
const SMA_N = 200;               // trend filter: close vs its 200-day average
const LMAX = 1.5;                // most index exposure any rule may take (×account)
const BAND = 0.1;                // rebalance only when the target moves this much

const spxS = M['.SPX'] || {};
const dates = Object.keys(spxS).sort().filter((d) => d >= (arg('--from') || '2024-01-02') && d <= (arg('--to') || '9999'));
const ff = (s) => { let last = null; return dates.map((d) => (s && s[d] != null && isFinite(+s[d]) && +s[d] > 0 ? (last = +s[d]) : last)); };
const P = ff(spxS), VIX = ff(M['.VIX']), T3 = ff(M['US3M']), Y10 = ff(M['US10Y']), GC = ff(M['@GC.1']);
const n = dates.length;
const rets = (a) => a.map((v, i) => (i && a[i - 1] > 0 && v > 0 ? v / a[i - 1] - 1 : 0));
const rS = rets(P), rG = rets(GC);
// 10-year Treasury held at constant maturity: carry minus duration × yield change plus convexity (par bond near 4–5%)
const DUR = 7.8, CONV = 75;
const rB = Y10.map((y, i) => { if (!i || y == null || Y10[i - 1] == null) return 0; const dy = (y - Y10[i - 1]) / 100; return Y10[i - 1] / 100 / 252 - DUR * dy + 0.5 * CONV * dy * dy; });
const rf = T3.map((y, i) => (i && T3[i - 1] != null ? T3[i - 1] / 100 / 252 : 0));
const R = { S: rS, B: rB, G: rG };

// EWMA variance per asset, seeded with the first 20 days
const ewma = (r) => { const out = new Array(n).fill(null); let v = 0; for (let i = 1; i < n; i++) { if (i <= 20) { v += r[i] * r[i] / 20; if (i === 20) out[i] = v; continue; } v = LAM * v + (1 - LAM) * r[i] * r[i]; out[i] = v; } return out; };
const VAR = { S: ewma(rS), B: ewma(rB), G: ewma(rG) };
const cov = (a, b) => { const out = new Array(n).fill(null); let c = 0; for (let i = 1; i < n; i++) { if (i <= 20) { c += R[a][i] * R[b][i] / 20; if (i === 20) out[i] = c; continue; } c = LAM * c + (1 - LAM) * R[a][i] * R[b][i]; out[i] = c; } return out; };
const COV = { SB: cov('S', 'B'), SG: cov('S', 'G'), BG: cov('B', 'G') };
const volA = (k, i) => Math.sqrt(VAR[k][i] * 252);
const sma = P.map((_, i) => { if (i < SMA_N - 1) return null; let s = 0; for (let k = i - SMA_N + 1; k <= i; k++) s += P[k]; return s / SMA_N; });
// the vol the index "normally" has: average implied vol over the past year (known at t), so average exposure stays near 1
const vixAvg = VIX.map((_, i) => { const a = VIX.slice(Math.max(0, i - 251), i + 1).filter((x) => x > 0); return a.length ? a.reduce((p, q) => p + q, 0) / a.length / 100 : null; });
// forecast vol: the larger of recent realised vol and implied vol (VIX), so exposure falls as soon as either rises
const fvol = (i) => Math.max(volA('S', i), (VIX[i] || 0) / 100);

// Black–Scholes put, for the put-writing rule
const ncdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804 * Math.exp(-x * x / 2); const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; };
const bsPut = (S, K, T, r, v) => { if (T <= 1e-9) return Math.max(K - S, 0); const sq = v * Math.sqrt(T), d1 = (Math.log(S / K) + (r + v * v / 2) * T) / sq; return K * Math.exp(-r * T) * ncdf(-(d1 - sq)) - S * ncdf(-d1); };

const START = SMA_N;             // every rule starts the same day, once the 200-day average exists
const RULES = {
  hold: { name: '지수 보유(S&P 500)', w: () => ({ S: 1 }) },
  sixty: { name: '60/40 (지수·10년물)', w: () => ({ S: 0.6, B: 0.4 }) },
  vt: { name: '변동성 목표', w: (i) => ({ S: Math.min(LMAX, vixAvg[i] / fvol(i)) }) },
  vtt: { name: '변동성 목표+추세', w: (i) => ({ S: Math.min(LMAX, vixAvg[i] / fvol(i)) * (P[i] >= sma[i] ? 1 : 0.25) }) },
  rp: { name: '리스크 패리티(지수·10년물·금)', w: (i) => {
    const iv = { S: 1 / volA('S', i), B: 1 / volA('B', i), G: 1 / volA('G', i) }, sum = iv.S + iv.B + iv.G;
    const w = { S: iv.S / sum, B: iv.B / sum, G: iv.G / sum };
    const pv = Math.sqrt(252 * (w.S * w.S * VAR.S[i] + w.B * w.B * VAR.B[i] + w.G * w.G * VAR.G[i] + 2 * (w.S * w.B * COV.SB[i] + w.S * w.G * COV.SG[i] + w.B * w.G * COV.BG[i])));
    const k = Math.min(2, vixAvg[i] / pv);  // same risk budget as the index, at most 2× gross
    return { S: w.S * k, B: w.B * k, G: w.G * k };
  } },
};

function stats(eq, from = 0, to = eq.length - 1) {
  const r = []; for (let i = from + 1; i <= to; i++) r.push(eq[i] / eq[i - 1] - 1);
  const f = []; for (let i = from + 1; i <= to; i++) f.push(rf[START + i]);
  const N = r.length, tot = eq[to] / eq[from] - 1, yrs = N / 252;
  const ex = r.map((x, j) => x - f[j]), mu = ex.reduce((a, b) => a + b, 0) / N, sd = Math.sqrt(ex.reduce((a, b) => a + (b - mu) ** 2, 0) / (N - 1));
  let pk = eq[from], mdd = 0; for (let i = from; i <= to; i++) { pk = Math.max(pk, eq[i]); mdd = Math.max(mdd, 1 - eq[i] / pk); }
  return { ret: +tot.toFixed(4), cagr: +((1 + tot) ** (1 / yrs) - 1).toFixed(4), vol: +(sd * Math.sqrt(252)).toFixed(4), sharpe: +((mu / sd) * Math.sqrt(252)).toFixed(2), mdd: +mdd.toFixed(4) };
}
function runWeights(rule) {
  const eq = [1]; let w = {}, e = 1, expo = 0, trades = 0;
  for (let i = START; i < n - 1; i++) {
    const tgt = rule.w(i); let move = 0;
    for (const k of new Set([...Object.keys(tgt), ...Object.keys(w)])) move = Math.max(move, Math.abs((tgt[k] || 0) - (w[k] || 0)));
    let tc = 0;
    if (move >= BAND || !Object.keys(w).length) { for (const k of new Set([...Object.keys(tgt), ...Object.keys(w)])) tc += Math.abs((tgt[k] || 0) - (w[k] || 0)) * COST; w = tgt; trades++; }
    let gross = 0, sw = 0; for (const k in w) { gross += w[k] * R[k][i + 1]; sw += w[k]; }
    e *= 1 + gross + (1 - sw) * rf[i + 1] - tc; eq.push(e); expo += w.S || 0;
  }
  return { eq, avgS: +(expo / (n - 1 - START)).toFixed(2), trades };
}
// sell a one-month at-the-money S&P 500 put every 21 trading days, secured by cash (like the CBOE PUT index); priced
// with Black–Scholes at implied vol = VIX × 0.9 (at-the-money vol sits below VIX, 확인필요), 1% of premium as cost.
// opt.gate(i): sell this month only when true (otherwise the cash waits a day and asks again)
// opt.contracts: whole SPY contracts (100 shares ≈ S&P 500 ÷ 10) on a $100,000 account instead of a fraction
function runPutWrite(opt = {}) {
  const IVK = 0.9, A0 = opt.contracts || opt.budget ? 100000 : 1;
  const eq = [1]; let cash = A0, q = 0, K = 0, t0 = 0, expo = 0, sold = 0, cr0 = 0;
  for (let i = START; i < n - 1; i++) {
    if (q && i - t0 >= 21) {
      const pay = Math.max(K - P[i], 0) - (opt.wing ? Math.max(K * opt.wing - P[i], 0) : 0);
      if (opt.cycles && opt.wing) opt.cycles.push((cr0 - pay) / (K * (1 - opt.wing) - cr0));   // the month's result per $1 of worst case
      cash -= q * pay; q = 0;
    }
    if (!q && (!opt.gate || opt.gate(i))) {
      K = P[i]; t0 = i;
      const cr = (bsPut(P[i], K, 21 / 252, T3[i] / 100, (VIX[i] / 100) * IVK) - (opt.wing ? bsPut(P[i], K * opt.wing, 21 / 252, T3[i] / 100, (VIX[i] / 100) * 1.15) : 0)) * 0.99;
      // risk budget: whole contracts whose worst case (spread width − credit) stays within opt.budget of the account,
      // and whose notional stays within opt.cap × account
      q = opt.budget ? Math.min(Math.floor((cash * opt.budget) / (10 * (K * (1 - opt.wing) - cr))), Math.floor((cash * opt.cap) / (10 * K))) * 10
        : opt.contracts ? Math.floor(cash / (10 * K)) * 10 : cash / K;
      if (q) { cash += q * cr; sold++; cr0 = cr; }
    }
    cash *= 1 + rf[i + 1];
    const T = Math.max(0, (21 - (i + 1 - t0)) / 252);
    const v = cash - (q ? q * (bsPut(P[i + 1], K, T, T3[i + 1] / 100, (VIX[i + 1] / 100) * IVK) - (opt.wing ? bsPut(P[i + 1], K * opt.wing, T, T3[i + 1] / 100, (VIX[i + 1] / 100) * 1.15) : 0)) : 0);
    expo += q ? (q * P[i]) / (eq[eq.length - 1] * A0) : 0;
    eq.push(v / A0);
  }
  return { eq, avgS: +(expo / (n - 1 - START)).toFixed(2), trades: sold };
}
const vrp = (i) => 0.9 * VIX[i] / 100 > volA('S', i);                  // implied vol above the realised-vol forecast
const cioGate = (i) => P[i] > sma[i] && VIX[i] >= 15 && VIX[i] < 30;   // today's wheel gate (not falling, VIX 15–30)

// Kelly: the share of the account to put at risk each month that maximises long-run growth, E[log(1 + f·x)], from the
// monthly results of the put spread (1 = the whole worst case lost, +0.2 = 20% of the worst case earned)
const cyc = []; runPutWrite({ gate: vrp, wing: 0.9, cycles: cyc });
let kelly = 0, bestG = 0;
for (let f = 0.005; f < 1; f += 0.005) { const g = cyc.reduce((a, x) => a + Math.log(1 + f * x), 0) / cyc.length; if (g > bestG) { bestG = g; kelly = f; } }
const kellyOut = { months: cyc.length, wins: cyc.filter((x) => x > 0).length, worst: +Math.min(...cyc).toFixed(3), mean: +(cyc.reduce((a, b) => a + b, 0) / cyc.length).toFixed(3), full: +kelly.toFixed(3), half: +(kelly / 2).toFixed(3) };
const out = { from: dates[START], to: dates[n - 1], days: n - 1 - START, rules: {} };
const curves = {};
for (const [k, rule] of Object.entries(RULES)) curves[k] = runWeights(rule);
curves.pw = runPutWrite(); RULES.pw = { name: '풋 매도(블랙–숄즈 모형)' };
curves.pwv = runPutWrite({ gate: vrp }); RULES.pwv = { name: '풋 매도·내재>실현 변동성일 때만' };
curves.pwg = runPutWrite({ gate: cioGate }); RULES.pwg = { name: '풋 매도·지금 휠 조건' };
curves.pwc = runPutWrite({ contracts: true }); RULES.pwc = { name: '풋 매도·SPY 계약 단위($10만)' };
curves.pwvc = runPutWrite({ gate: vrp, contracts: true }); RULES.pwvc = { name: '내재>실현일 때만·SPY 계약 단위' };
curves.pwvs = runPutWrite({ gate: vrp, contracts: true, wing: 0.9 }); RULES.pwvs = { name: '위+10% 아래 풋 매수(손실 상한)' };
curves.pwvb = runPutWrite({ gate: vrp, wing: 0.9, budget: 0.12, cap: 1.5 }); RULES.pwvb = { name: '위·손실 한도 12%로 계약 수' };
// stress windows: the index's own worst drawdown in the window and the latest 7 trading days
const eqH = curves.hold.eq; let pk = 0, best = [0, 0, 0];
for (let i = 0; i < eqH.length; i++) { if (eqH[i] > eqH[pk]) pk = i; const dd = 1 - eqH[i] / eqH[pk]; if (dd > best[2]) best = [pk, i, dd]; }
const L = eqH.length - 1, half = Math.floor(L / 2);
for (const [k, c] of Object.entries(curves)) {
  const s = stats(c.eq);
  out.rules[k] = Object.assign({ name: RULES[k].name }, s, {
    avgS: c.avgS,
    h1: stats(c.eq, 0, half), h2: stats(c.eq, half, L),
    crash: +(c.eq[best[1]] / c.eq[best[0]] - 1).toFixed(4),
    last7: +(c.eq[L] / c.eq[Math.max(0, L - 7)] - 1).toFixed(4),
  });
}
out.crash = { from: dates[START + best[0]], to: dates[START + best[1]] };
out.split = dates[START + half];
out.kelly = kellyOut;
if (process.argv.includes('--json')) console.log(JSON.stringify(out));
else {
  const p = (v) => (v == null ? '-' : (v * 100).toFixed(1) + '%');
  console.log(`기간 ${out.from}~${out.to} (${out.days}거래일) · 지수 최대 하락 구간 ${out.crash.from}~${out.crash.to} · 반으로 나눈 기준일 ${out.split}`);
  console.log('규칙'.padEnd(26) + '수익률  연복리  변동성 샤프  최대낙폭  하락구간  최근7일  앞절반   뒷절반  평균지수비중');
  console.log(`켈리: ${kellyOut.months}개월 중 이익 ${kellyOut.wins}개월, 최악의 달 ${kellyOut.worst}, 평균 ${kellyOut.mean} → 최적 위험 비중 ${(kellyOut.full * 100).toFixed(1)}%, 절반 켈리 ${(kellyOut.half * 100).toFixed(1)}%`);
  for (const r of Object.values(out.rules)) console.log(r.name.padEnd(24) + [p(r.ret), p(r.cagr), p(r.vol), String(r.sharpe), p(r.mdd), p(r.crash), p(r.last7), p(r.h1.ret) + '/' + p(r.h1.mdd), p(r.h2.ret) + '/' + p(r.h2.mdd), r.avgS == null ? '-' : String(r.avgS)].map((x) => x.padStart(7)).join(' '));
}
