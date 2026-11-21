// The derivatives part of the combined account: CME micro futures (trend following across stock indexes, small caps,
// Treasuries, commodities and crypto), SPY option put spreads (a credit spread for income in an uptrend, a debit spread
// to protect the account's stocks when the market turns), and a synthetic step-down ELS on the S&P 500 and the
// Nasdaq 100 (priced by Monte Carlo the way issuers price them). Idle cash earns the RP rate.
// tools/run.mjs runs it: nightly() once per closed trading day (settlement, decisions), session() during the day
// (marks, option orders). Prices: CNBC futures quotes (front and next contract with expiry and settlement), CBOE delayed
// option chains, CNBC/FRED history (data/macro_hist.json). No keys.
(function (root) {
  'use strict';
  // ── futures: [key, CNBC root, name, group, multiplier, margin as a share of notional (approximate), tick, exchange fee]
  // groups: eq stock index, sc small caps, rt Treasuries, cm commodities, cr crypto
  const FUT = [
    ['MES', '@SP', 'S&P 500 마이크로 선물', 'eq', 5, 0.07, 0.25, 0.35],
    ['MNQ', '@ND', '나스닥 100 마이크로 선물', 'eq', 2, 0.08, 0.25, 0.35],
    ['MYM', '@DJ', '다우 마이크로 선물', 'eq', 0.5, 0.06, 1, 0.35],
    ['M2K', '@TFS', '러셀 2000 마이크로 선물(중소형주)', 'sc', 5, 0.08, 0.1, 0.35],
    ['ZT', '@TU', '미국 2년 국채 선물', 'rt', 2000, 0.006, 0.00390625, 0.8],
    ['ZF', '@FV', '미국 5년 국채 선물', 'rt', 1000, 0.015, 0.0078125, 0.8],
    ['ZN', '@TY', '미국 10년 국채 선물', 'rt', 1000, 0.023, 0.015625, 0.8],
    ['ZB', '@US', '미국 30년 국채 선물', 'rt', 1000, 0.045, 0.03125, 0.8],
    ['MCL', '@CL', 'WTI 원유 마이크로 선물', 'cm', 100, 0.09, 0.01, 0.8],
    ['MGC', '@GC', '금 마이크로 선물', 'cm', 10, 0.05, 0.1, 0.8],
    ['SIL', '@SI', '은 마이크로 선물', 'cm', 1000, 0.08, 0.005, 0.8],
    ['MHG', '@HG', '구리 마이크로 선물', 'cm', 2500, 0.06, 0.0005, 0.8],
    ['MBT', '@BTC', '비트코인 마이크로 선물', 'cr', 0.1, 0.42, 5, 2.5],
    ['MET', '@ETH', '이더리움 마이크로 선물', 'cr', 0.1, 0.45, 0.5, 0.2],
  ].map(([key, cnbc, name, g, mult, mr, tick, xfee]) => ({ key, cnbc, name, g, mult, mr, tick, xfee }));
  const FUT_BY = Object.fromEntries(FUT.map((f) => [f.key, f]));
  const GROUP_NAME = { eq: '주가지수', sc: '중소형주', rt: '국채', cm: '원자재', cr: '코인' };
  const CFG = {
    // Robinhood futures: $0.75 commission and $0.02 NFA fee per contract per side, plus the exchange fee above (확인필요)
    futComm: 0.75, nfa: 0.02,
    // options at Robinhood: no commission; regulatory and clearing fees about $0.04 per contract per side (확인필요)
    optFee: 0.04,
    rpSpread: 0.0025,           // RP rate = US 1-month T-bill yield − 0.25%p (확인필요)
    cta: { fast: 20, slow: 100, l1: 60, l2: 120, vol: 60, stopK: 4, maxPos: 5, marginCap: 0.5, rho: 0.3 },
    credit: { delta: 0.2, width: 15, dteMin: 28, dteMax: 50, dteAim: 40, minCreditPct: 0.2, riskPer: 0.015, maxRisk: 0.04, take: 0.5, stopX: 3, exitDte: 14 },
    hedge: { longDelta: 0.3, shortDelta: 0.08, dteMin: 40, dteMax: 80, dteAim: 60, ratio: 0.5, exitDte: 15 },
    // bear call spreads on SPY: the mirror of the put spreads, for falling or sideways markets (with both: an iron condor)
    // (calls are priced lower than puts on index options, so the spread is narrower and needs 15% of its width)
    ccall: { delta: 0.2, width: 10, dteMin: 28, dteMax: 50, dteAim: 40, minCreditPct: 0.15, riskPer: 0.015, maxRisk: 0.04, take: 0.5, stopX: 3, exitDte: 14 },
    // the wheel on IWM: sell a cash-secured put; if it ends in the money the shares are bought at the strike, then covered
    // calls are sold on them (strike at or above what the shares cost) until they are called away; premium of at least
    // 0.4% of the price per month-ish expiry, at most 30% of the account tied up
    wheel: { und: 'IWM', putDelta: 0.25, callDelta: 0.3, dteMin: 25, dteMax: 50, dteAim: 35, minPrem: 0.004, take: 0.6, maxShare: 0.3 },
    // the base layer: every month an S&P 500 put spread (sell the at-the-money SPY put, buy the one 10% lower, about 30
    // days out), only while options are priced above the volatility the index is actually showing (implied vol of the
    // at-the-money put > the EWMA forecast of realised vol: the variance risk premium). Worst case per spread = (width −
    // credit) × 100; contracts so the worst case stays within `budget` of the account (startBudget for the first
    // startCycles months, until it has its own record) and the notional within `cap` × account. Held to expiry, opened
    // only at night on closing quotes (the model in tools/pf_lab.mjs decides at the close too).
    // owner's settings (2026-11-21: buying and selling calls and puts, the risky ones too). The rule is the same as the
    // base layer's, from the other side: options are BOUGHT only while cheap (implied vol of the at-the-money option
    // below the realised-vol forecast), in the direction of the S&P 500's trend (calls when it rises, puts when it
    // falls), at most riskPer of the account per trade and maxRisk in all; out at +100% or −50% of the price paid, or
    // 10 days before expiry. A call is SOLD naked only while options are dear and the market is not rising, ~0.15 delta,
    // one contract whose notional fits within maxNotional × account, Reg T margin held aside (20% of the stock less the
    // out-of-the-money amount, at least 10%, plus the premium); bought back at 50% of the premium, at 3× it, or 7 days
    // before expiry
    // the stress test over every short option together: if the S&P 500 (and IWM) moved `move` against them overnight,
    // the loss may not pass `max` of the account; a new short option that would break it is not opened
    stress: { move: 0.15, max: 0.2 },
    longOpt: { und: 'SPY', dteMin: 30, dteMax: 60, dteAim: 45, delta: 0.4, riskPer: 0.01, maxRisk: 0.04, take: 1, stop: 0.5, exitDte: 10 },
    nakedCall: { und: 'SPY', dteMin: 21, dteMax: 45, dteAim: 30, delta: 0.15, maxNotional: 0.8, take: 0.5, stopX: 3, exitDte: 7 },
    base: { und: 'SPY', dteMin: 21, dteMax: 45, dteAim: 30, wing: 0.9, budget: 0.12, startBudget: 0.06, startCycles: 3, cap: 1.5, lam: 0.94 },
    els: { tenor: 3, obs: [0.9, 0.9, 0.85, 0.85, 0.8, 0.75], ki: 0.45, fvTarget: 0.98, lot: 5000, qSpx: 0.012, qNdx: 0.007, earlySale: 0.95, paths: 6000, markPaths: 1500 },
  };
  const DAY = 864e5, ROLL_DAYS = 12;          // roll this many calendar days before the front contract expires
  const r2 = (v) => Math.round(v * 100) / 100;
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
  const addMonths = (d, m) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
  const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
  const pc = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%';

  // ── math: normal distribution, Black-Scholes for European puts, a small seeded random generator
  function ncdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
  function bsPut(S, K, T, r, q, v) {
    if (T <= 0 || v <= 0) return { px: Math.max(0, K - S), delta: S < K ? -1 : 0 };
    const sq = v * Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + v * v / 2) * T) / sq, d2 = d1 - sq;
    return { px: K * Math.exp(-r * T) * ncdf(-d2) - S * Math.exp(-q * T) * ncdf(-d1), delta: -Math.exp(-q * T) * ncdf(-d1) };
  }
  function rng(seed) {
    let s = (seed >>> 0) || 88172645;
    const u = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s + 0.5) / 4294967296; };
    let spare = null;
    return () => { if (spare != null) { const v = spare; spare = null; return v; } let a, b, q; do { a = 2 * u() - 1; b = 2 * u() - 1; q = a * a + b * b; } while (q >= 1 || q === 0); const f = Math.sqrt(-2 * Math.log(q) / q); spare = b * f; return a * f; };
  }
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  // ── the ELS: worst of two indexes, step-down early redemption every 6 months, knock-in watched at each daily close.
  // Returns A and B with value = A + coupon × B (per 1 of principal), so the fair coupon solves A + c·B = fvTarget.
  function elsValue(o) {
    // o: {perf: [x1, x2] now vs. the start, t0: years since issue, sig, rho, r, q, obs: [[years from issue, barrier]], ki, kiHit, T, paths, seed}
    const steps = Math.max(1, Math.round((o.T - o.t0) * 252)), dt = (o.T - o.t0) / steps, rand = rng(o.seed);
    const c1 = Math.sqrt(1 - o.rho * o.rho);
    const m = [0, 1].map((k) => (o.r - o.q[k] - o.sig[k] * o.sig[k] / 2) * dt), s = [0, 1].map((k) => o.sig[k] * Math.sqrt(dt));
    const obsStep = o.obs.map(([t, b]) => [Math.round((t - o.t0) / dt), b, t]).filter((x) => x[0] >= 1);
    let A = 0, B = 0, pCall = 0, pKi = 0;
    for (let p = 0; p < o.paths; p++) {
      let x1 = Math.log(o.perf[0]), x2 = Math.log(o.perf[1]), ki = !!o.kiHit, k = 0, done = false;
      for (let i = 1; i <= steps; i++) {
        const z1 = rand(), z2 = o.rho * z1 + c1 * rand();
        x1 += m[0] + s[0] * z1; x2 += m[1] + s[1] * z2;
        const w = Math.exp(Math.min(x1, x2));
        if (w <= o.ki) ki = true;
        if (k < obsStep.length && i === obsStep[k][0]) {
          const last = k === obsStep.length - 1, tk = obsStep[k][2], disc = Math.exp(-o.r * (tk - o.t0));
          if (w >= obsStep[k][1] || (last && !ki)) { A += disc; B += disc * tk; pCall += last ? 0 : 1; done = true; break; }
          if (last) { A += disc * w; done = true; break; }
          k++;
        }
      }
      if (!done) { const disc = Math.exp(-o.r * (o.T - o.t0)); A += disc * Math.exp(Math.min(x1, x2)); }
      if (ki) pKi++;
    }
    return { A: A / o.paths, B: B / o.paths, pCall: pCall / o.paths, pKi: pKi / o.paths };
  }

  // ── state
  function init(now, date) {
    return { v: 1, start: date, at: now, date: null, cash: 0, funded: 0, fut: {}, opt: [], els: [], orders: [], fills: [], closed: [],
      hist: [], rp: 0, fees: 0, last: {}, prevC2: {}, log: [], transfers: [], seq: 0 };
  }
  function note(st, now, kind, text) { st.log.push({ t: now, kind, text }); if (st.log.length > 120) st.log.splice(0, st.log.length - 120); }
  function fill(st, f) { st.fills.push(f); if (st.fills.length > 400) st.fills.splice(0, st.fills.length - 400); }
  function fund(st, amount, now, id, why) { st.cash = r2(st.cash + amount); st.funded = r2(st.funded + amount); st.transfers.push({ id, t: now, amount: r2(amount) }); note(st, now, 'fund', why || (amount >= 0 ? `계좌 안에서 파생 운용에 ${usd(amount)} 배분` : `파생 운용에서 ${usd(-amount)} 회수`)); }

  // ── values
  const futFee = (f, n) => n * (CFG.futComm + CFG.nfa + f.xfee);
  function futMark(st, key) { const p = st.fut[key]; return p ? p.mark : 0; }
  // options: spreads (side credit, ccall, hedge: kLong/kShort) and single short legs (csp, cc: k); value per share,
  // negative for what is owed. Positions from before calls existed have no 'right' and are puts.
  const single = (o) => o.side === 'csp' || o.side === 'cc' || o.side === 'ncall' || o.side === 'lcall' || o.side === 'lput';
  const rightOf = (o) => o.right || (o.side === 'cc' || o.side === 'ccall' || o.side === 'ncall' || o.side === 'lcall' ? 'C' : 'P');
  const legs = (ch, e, right) => (ch && ch.exps && ch.exps[e] && ch.exps[e][right === 'C' ? 'calls' : 'puts']) || [];
  const rowAt = (ch, e, right, K) => legs(ch, e, right).find((x) => Math.abs(x[0] - K) < 1e-9);
  const midOf = (r) => (r && r[1] >= 0 && r[2] > 0 ? (r[1] + r[2]) / 2 : null);
  function optMid(o, ch) {           // value per spread (long − short) or of the short option (negative), from the chain
    const r = rightOf(o);
    if (single(o)) { const m = midOf(rowAt(ch, o.exp, r, o.k)); return m != null ? (o.long ? m : -m) : null; }
    const a = midOf(rowAt(ch, o.exp, r, o.kLong)), b = midOf(rowAt(ch, o.exp, r, o.kShort));
    return a != null && b != null ? a - b : null;
  }
  function intrinsic(o, S) {
    const r = rightOf(o), iv = (K) => (r === 'C' ? Math.max(0, S - K) : Math.max(0, K - S));
    return single(o) ? (o.long ? 1 : -1) * iv(o.k) : iv(o.kLong) - iv(o.kShort);
  }
  function optName(o) {
    const u = o.und || 'SPY', e = o.exp.slice(2).replace(/-/g, '');
    if (o.side === 'csp') return `${u} ${e} ${o.k} 풋(현금 담보)`;
    if (o.side === 'cc') return `${u} ${e} ${o.k} 콜(커버드콜)`;
    if (o.side === 'lcall') return `${u} ${e} ${o.k} 콜 매수`;
    if (o.side === 'lput') return `${u} ${e} ${o.k} 풋 매수`;
    if (o.side === 'ncall') return `${u} ${e} ${o.k} 콜 매도(무담보)`;
    if (o.side === 'ccall') return `${u} ${e} ${o.kShort}/${o.kLong} 콜 스프레드`;
    if (o.side === 'base') return `${u} ${e} ${o.kShort}/${o.kLong} 풋 스프레드(기반층)`;
    return `${u} ${e} ${o.kLong}/${o.kShort} 풋 스프레드`;
  }
  function equity(st) {
    let v = st.cash;
    for (const k in st.fut) { const p = st.fut[k]; v += p.qty * p.mult * (p.px - p.mark); }
    for (const o of st.opt) v += o.n * 100 * (o.val != null ? o.val : o.cost);
    for (const e of st.els) v += e.amount * (e.val != null ? e.val : 1);
    for (const u in st.stk || {}) v += st.stk[u].qty * st.stk[u].px;
    return r2(v);
  }
  function marginUsed(st) { let m = 0; for (const k in st.fut) { const p = st.fut[k], f = FUT_BY[k]; m += Math.abs(p.qty) * p.px * f.mult * f.mr; } return r2(m); }
  // cash the options tie up: a spread's width, a cash-secured put's whole strike (covered calls are covered by the shares)
  const spreadRisk = (o) => (o.side === 'credit' || o.side === 'base' ? o.n * 100 * (o.kShort - o.kLong) : o.side === 'ccall' ? o.n * 100 * (o.kLong - o.kShort) : 0);
  function optRisk(st) { let m = 0; for (const o of st.opt) m += o.side === 'csp' ? o.n * 100 * o.k : o.side === 'ncall' ? o.margin || 0 : spreadRisk(o); return m; }
  function free(st) { return st.cash - marginUsed(st) - optRisk(st); }

  // ── futures: close-to-close history (front contract) with today's settlement appended
  function series(hist, f, date, today) {
    const h = (hist && hist[f.cnbc + '.1']) || {};
    const ds = Object.keys(h).filter((d) => d <= date).sort();
    const out = ds.map((d) => h[d]);
    if (today > 0 && ds[ds.length - 1] !== date) out.push(today);
    return out;
  }
  function trend(c, cfg) {
    const n = c.length;
    if (n < cfg.l2 + 2) return null;
    const ema = (k) => { const a = 2 / (k + 1); let e = c[0]; for (let i = 1; i < n; i++) e += a * (c[i] - e); return e; };
    const r1 = c[n - 1] / c[n - 1 - cfg.l1] - 1, r2v = c[n - 1] / c[n - 1 - cfg.l2] - 1, ef = ema(cfg.fast), es = ema(cfg.slow);
    const rets = []; for (let i = n - cfg.vol; i < n; i++) rets.push(Math.log(c[i] / c[i - 1]));
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length, sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1));
    const s = (Math.sign(r1) + Math.sign(r2v) + Math.sign(ef - es)) / 3;
    return { s, r1, r2: r2v, ef, es, sd, px: c[n - 1], strength: Math.abs(r2v) / (sd * Math.sqrt(cfg.l2)) };
  }

  // ── one closed trading day: settle, pay RP, roll, follow the trends, manage options and the ELS
  function nightly(st, ctx) {
    const d = ctx.date, now = ctx.now, cio = ctx.cio || {};
    if (st.date && st.date >= d) return { skipped: true };
    const acct = Math.max(1, ctx.account || equity(st));
    // RP on idle cash for the calendar days since the last close
    if (st.date && st.cash > 0 && isNum(ctx.rp)) {
      const n = days(st.date, d), rate = Math.max(0, ctx.rp / 100 - CFG.rpSpread), add = r2(st.cash * rate * n / 365);
      if (add > 0) { st.cash = r2(st.cash + add); st.rp = r2(st.rp + add); }
    }
    // 1. futures: daily settlement into cash, rolls a few days before expiry
    for (const k of Object.keys(st.fut)) {
      const p = st.fut[k], f = FUT_BY[k], q = (ctx.fut || {})[k] || {}, c1 = q.c1, c2 = q.c2;
      let px = null;
      if (c1 && c1.contract === p.contract) px = c1.settleDate === d && c1.settle > 0 ? c1.settle : c1.px;
      else if (c2 && c2.contract === p.contract) px = c2.settleDate === d && c2.settle > 0 ? c2.settle : c2.px;
      if (!(px > 0)) {
        if (c1 && c1.px > 0 && c1.contract !== p.contract) {
          const fee = r2(futFee(f, Math.abs(p.qty)) * 2), slip = r2(Math.abs(p.qty) * f.mult * f.tick * 2);
          st.cash = r2(st.cash - fee - slip); st.fees = r2(st.fees + fee); p.feesPaid = r2((p.feesPaid || 0) + fee + slip);
          fill(st, { t: now, date: d, kind: 'fut', key: k, name: f.name, side: 'roll', qty: p.qty, px: c1.px, from: p.contract, to: c1.contract, fee: r2(fee + slip), why: `${p.contract} 시세가 더 나오지 않아 마지막 정산가로 정리하고 ${c1.contract}로 넘김` });
          p.contract = c1.contract; p.exp = c1.exp; p.mark = c1.px; p.px = c1.px; p.best = c1.px;
        } else note(st, now, 'warn', `${f.name}: ${p.contract} 계약 시세가 없어 어제 가격으로 둡니다.`);
        continue;
      }
      const pnl = r2(p.qty * f.mult * (px - p.mark));
      st.cash = r2(st.cash + pnl); p.real = r2((p.real || 0) + pnl); p.mark = px; p.px = px;
      p.best = p.qty > 0 ? Math.max(p.best, px) : Math.min(p.best, px);
      if (c1 && c1.contract === p.contract && c1.exp && days(d, c1.exp) <= ROLL_DAYS && c2 && c2.px > 0 && c2.contract !== p.contract) {
        const fee = r2(futFee(f, Math.abs(p.qty)) * 2), slip = r2(Math.abs(p.qty) * f.mult * f.tick * 2);
        st.cash = r2(st.cash - fee - slip); st.fees = r2(st.fees + fee); p.feesPaid = r2((p.feesPaid || 0) + fee + slip);
        fill(st, { t: now, date: d, kind: 'fut', key: k, name: f.name, side: 'roll', qty: p.qty, px: c2.px, from: p.contract, to: c2.contract, fee: r2(fee + slip), why: `만기(${c1.exp})가 ${days(d, c1.exp)}일 남아 ${p.contract} → ${c2.contract}로 넘김` });
        p.contract = c2.contract; p.exp = c2.exp; p.mark = c2.px; p.px = c2.px; p.best = c2.px;
      }
    }
    // 2. trend signals and target positions
    const fb = cio.fut || { budget: 0.06, tilt: {} };
    const sig = {};
    for (const f of FUT) {
      const q = (ctx.fut || {})[f.key];
      const today = q && q.c1 ? (q.c1.settleDate === d && q.c1.settle > 0 ? q.c1.settle : q.c1.px) : null;
      const t = trend(series(ctx.hist, f, d, today), CFG.cta);
      if (t) sig[f.key] = t;
    }
    st.signals = Object.fromEntries(Object.entries(sig).map(([k, t]) => [k, { s: r4(t.s), r60: r4(t.r1), r120: r4(t.r2), vol: r4(t.sd), px: t.px }]));
    const daily$ = acct * (fb.budget || 0) / Math.sqrt(252), per = daily$ / 2;
    const tilt = (f, dir) => { const g = (fb.tilt || {})[f.g]; return g ? (dir > 0 ? g[0] : g[1]) : 1; };
    // exits: the trend turned, or the trailing stop (4 daily moves from the best close)
    for (const k of Object.keys(st.fut)) {
      const p = st.fut[k], f = FUT_BY[k], t = sig[k], q = (ctx.fut || {})[k];
      const dir = Math.sign(p.qty), live = q && q.c1 && q.c1.contract === p.contract ? q.c1.px : q && q.c2 && q.c2.contract === p.contract ? q.c2.px : p.px;
      let why = null;
      if (t && (dir > 0 ? t.s <= -1 / 3 : t.s >= 1 / 3)) why = `추세 반전(60일 ${pc(t.r1)}, 120일 ${pc(t.r2)})`;
      else if (t && (dir > 0 ? p.px <= p.best * (1 - CFG.cta.stopK * t.sd) : p.px >= p.best * (1 + CFG.cta.stopK * t.sd))) why = `추적 손절(최고점 대비 ${(CFG.cta.stopK * t.sd * 100).toFixed(1)}%)`;
      else if (tilt(f, dir) === 0) why = `AI 배분: ${GROUP_NAME[f.g]} ${dir > 0 ? '매수' : '매도'} 쉼`;
      if (why && live > 0) closeFut(st, k, live, now, d, why);
    }
    // entries: strongest agreeing trends first while the estimated risk of the futures fits the budget
    const held = Object.keys(st.fut);
    let risk2 = 0;
    for (const k of held) { const t = sig[k], p = st.fut[k]; if (t) { const r = Math.abs(p.qty) * t.sd * p.px * p.mult; risk2 += r * r; } }
    const cands = ctx.brake ? [] : FUT.filter((f) => !st.fut[f.key] && sig[f.key] && Math.abs(sig[f.key].s) === 1).map((f) => ({ f, t: sig[f.key], dir: Math.sign(sig[f.key].s) }))
      .filter((c) => tilt(c.f, c.dir) > 0).sort((a, b) => b.t.strength * tilt(b.f, b.dir) - a.t.strength * tilt(a.f, a.dir));
    for (const c of cands) {
      if (Object.keys(st.fut).length >= CFG.cta.maxPos) break;
      const q = (ctx.fut || {})[c.f.key], c1 = q && q.c1;
      if (!c1 || !(c1.px > 0)) continue;
      const use = c1.exp && days(d, c1.exp) <= ROLL_DAYS && q.c2 && q.c2.px > 0 ? q.c2 : c1;
      const one = c.t.sd * use.px * c.f.mult, want = per * tilt(c.f, c.dir) / one;
      if (2 * futFee(c.f, 1) + 2 * c.f.mult * c.f.tick > 0.1 * one) continue;      // a round trip must cost under 10% of a day's risk
      let n = Math.floor(want + 0.5);
      if (n === 0 && want >= 0.4 && one <= per * 2.5) n = 1;
      if (n < 1) continue;
      const add = n * one, est = Math.sqrt(risk2 + add * add + 2 * CFG.cta.rho * Math.sqrt(risk2) * add);
      if (est > daily$ * 1.25 && Object.keys(st.fut).length >= 1) continue;
      const margin = n * use.px * c.f.mult * c.f.mr;
      if (marginUsed(st) + margin > Math.max(0, st.cash - optRisk(st)) * CFG.cta.marginCap) continue;
      openFut(st, c.f, c.dir * n, use, now, d, `${GROUP_NAME[c.f.g]} ${c.dir > 0 ? '상승' : '하락'} 추세: 60일 ${pc(c.t.r1)}, 120일 ${pc(c.t.r2)}, 20일 평균이 100일 평균 ${c.t.ef > c.t.es ? '위' : '아래'}. 하루 변동 ${(c.t.sd * 100).toFixed(1)}% 기준 ${n}계약(1계약 하루 위험 약 ${usd(one)})`);
      risk2 += add * add;
    }
    // 3. options (managed again in the session with fresh quotes)
    manageOptions(st, ctx, true);
    // 4. the ELS: knock-in, early redemption, maturity, value; new issue when the AI allows it
    manageEls(st, ctx);
    st.date = d; st.at = now;
    st.hist.push({ date: d, eq: equity(st), cash: st.cash, margin: marginUsed(st) });
    if (st.hist.length > 800) st.hist.splice(0, st.hist.length - 800);
    return { skipped: false };
  }
  function openFut(st, f, qty, q, now, d, why) {
    const fee = r2(futFee(f, Math.abs(qty))), slip = r2(Math.abs(qty) * f.mult * f.tick);
    st.cash = r2(st.cash - fee - slip); st.fees = r2(st.fees + fee);
    st.fut[f.key] = { key: f.key, name: f.name, g: f.g, mult: f.mult, qty, contract: q.contract, exp: q.exp, entry: q.px, mark: q.px, px: q.px, best: q.px, date: d, t: now, why, real: 0, feesPaid: r2(fee + slip) };
    fill(st, { t: now, date: d, kind: 'fut', key: f.key, name: f.name, side: qty > 0 ? 'buy' : 'sell', qty, px: q.px, contract: q.contract, fee: r2(fee + slip), why });
  }
  function closeFut(st, k, px, now, d, why) {
    const p = st.fut[k], f = FUT_BY[k];
    const fee = r2(futFee(f, Math.abs(p.qty))), slip = r2(Math.abs(p.qty) * f.mult * f.tick);
    const last = r2(p.qty * f.mult * (px - p.mark));
    st.cash = r2(st.cash + last - fee - slip); st.fees = r2(st.fees + fee);
    const pnl = r2((p.real || 0) + last - (p.feesPaid || 0) - fee - slip);
    fill(st, { t: now, date: d, kind: 'fut', key: k, name: f.name, side: p.qty > 0 ? 'sell' : 'buy', qty: -p.qty, px, contract: p.contract, fee: r2(fee + slip), pnl, why });
    st.closed.push({ kind: 'fut', s: 'cta', key: k, name: f.name, qty: p.qty, entry: p.entry, exit: px, from: p.date, to: d, pnl, why });
    delete st.fut[k];
  }

  // ── options. ctx.chain: {SPY: {spot, at, exps: {YYYY-MM-DD: {puts: [[K, bid, ask, iv, delta]], calls: [...]}}}, IWM: ...}
  function pickExp(ch, d, lo, hi, aim) {
    const ok = Object.keys((ch && ch.exps) || {}).filter((e) => { const n = days(d, e); return n >= lo && n <= hi; });
    return ok.sort((a, b) => Math.abs(days(d, a) - aim) - Math.abs(days(d, b) - aim))[0] || null;
  }
  // the quote nearest a delta (puts have negative deltas), with both a bid and an ask
  const nearD = (rows, delta, right) => rows.filter((r) => isNum(r[4]) && (right === 'C' ? r[4] > 0 : r[4] < 0) && r[1] > 0 && r[2] > 0)
    .sort((a, b) => Math.abs(Math.abs(a[4]) - delta) - Math.abs(Math.abs(b[4]) - delta))[0];
  const near = (puts, delta) => nearD(puts, delta, 'P');
  function stockBuy(st, u, qty, px, now, d, why) {
    st.stk = st.stk || {};
    const x = st.stk[u] || (st.stk[u] = { sym: u, qty: 0, cost: 0, px, since: d });
    x.cost = (x.cost * x.qty + px * qty) / (x.qty + qty); x.qty += qty; x.px = px;
    st.cash = r2(st.cash - qty * px);
    fill(st, { t: now, date: d, kind: 'stk', id: u, name: `${u} ${qty}주`, side: 'buy', qty, px: r4(px), fee: 0, why });
  }
  function stockSell(st, u, qty, px, now, d, why) {
    const x = st.stk && st.stk[u];
    if (!x || !(qty > 0)) return;
    const q = Math.min(qty, x.qty), pnl = r2((px - x.cost) * q);
    st.cash = r2(st.cash + q * px); x.qty -= q;
    fill(st, { t: now, date: d, kind: 'stk', id: u, name: `${u} ${q}주`, side: 'sell', qty: q, px: r4(px), fee: 0, pnl, why });
    st.closed.push({ kind: 'stk', s: 'wheel', id: u, n: q, from: x.since, to: d, pnl, why });
    if (x.qty <= 0) delete st.stk[u];
  }
  // a credit spread on SPY: puts below the market (side credit) or calls above it (side ccall)
  function openCreditSpread(st, ch, ctx, right, acct) {
    const c = right === 'C' ? CFG.ccall : CFG.credit, side = right === 'C' ? 'ccall' : 'credit', d = ctx.date;
    const open = st.opt.filter((o) => o.side === side), used = open.reduce((t, o) => t + spreadRisk(o), 0);
    const e = pickExp(ch, d, c.dteMin, c.dteMax, c.dteAim);
    if (!e || open.some((o) => o.exp === e) || used >= acct * c.maxRisk) return;
    const rows = legs(ch, e, right), sh = nearD(rows, c.delta, right);
    const lg = sh && rows.find((r) => Math.abs(r[0] - (right === 'C' ? sh[0] + c.width : sh[0] - c.width)) < 1e-9 && r[2] > 0);
    if (!sh || !lg) return;
    const credit = sh[1] - lg[2], width = Math.abs(lg[0] - sh[0]);          // sell at the bid, buy at the ask
    if (!(credit >= width * c.minCreditPct)) return;
    const n = Math.max(0, Math.min(Math.floor(acct * c.riskPer / ((width - credit) * 100)), Math.floor((acct * c.maxRisk - used) / ((width - credit) * 100))));
    if (n < 1 || free(st) <= n * width * 100) return;
    const vix = isNum(ctx.vix) ? ctx.vix.toFixed(1) : '-';
    const why = right === 'C'
      ? `S&P 500이 오르기 어려운 국면에 옵션값이 높아(VIX ${vix}) 콜 스프레드를 팝니다. SPY ${sh[0]}콜 매도(델타 ${sh[4].toFixed(2)})·${lg[0]}콜 매수, 받은 값 $${credit.toFixed(2)} (최대 손실 $${((width - credit) * 100 * n).toFixed(0)})`
      : `S&P 500 상승·횡보 국면에 옵션 프리미엄이 높아(VIX ${vix}) 풋 스프레드를 팝니다. SPY ${sh[0]}풋 매도(델타 ${sh[4].toFixed(2)})·${lg[0]}풋 매수, 받은 값 $${credit.toFixed(2)} (최대 손실 $${((width - credit) * 100 * n).toFixed(0)})`;
    openOpt(st, { side, und: 'SPY', right, exp: e, kShort: sh[0], kLong: lg[0], n, cost: -credit, spot: ch.spot, why }, ctx.now, d);
  }
  // realised-vol forecast: EWMA (RiskMetrics λ) of the S&P 500's daily returns, annualised; seeded with 20 days
  function rvForecast(spx, lam) {
    const ks = Object.keys(spx || {}).sort().slice(-260), p = ks.map((k) => +spx[k]).filter((v) => v > 0);
    if (p.length < 40) return null;
    let v = 0;
    for (let i = 1; i < p.length; i++) { const r = p[i] / p[i - 1] - 1; v = i <= 20 ? v + (r * r) / 20 : lam * v + (1 - lam) * r * r; }
    return Math.sqrt(v * 252);
  }
  // implied vol from a put's price (bisection on Black–Scholes), for chains whose quote carries none
  function ivFromPut(px, S, K, T, r) {
    if (!(px > 0) || !(T > 0)) return null;
    let lo = 0.01, hi = 3;
    for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (bsPut(S, K, T, r, 0, m).px > px) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  function openBase(st, ch, ctx, acct) {
    const B = CFG.base, d = ctx.date, S = ch.spot, now = ctx.now;
    const e = pickExp(ch, d, B.dteMin, B.dteMax, B.dteAim);
    if (!e || !(S > 0)) return;
    const puts = legs(ch, e, 'P').filter((r) => r[1] > 0 && r[2] > 0);
    const sh = puts.filter((r) => r[0] <= S).sort((a, b) => b[0] - a[0])[0];              // at the money (at or just below)
    const lg = puts.filter((r) => r[0] <= S * B.wing).sort((a, b) => b[0] - a[0])[0];     // the protective put, 10% lower
    if (!sh || !lg || !(lg[0] < sh[0])) return;
    const T = days(d, e) / 365, rf = isNum(ctx.rf) ? ctx.rf : 0.04;
    const iv = isNum(sh[3]) && sh[3] > 0 ? sh[3] : ivFromPut(midOf(sh), S, sh[0], T, rf);
    const hs = Object.assign({}, ctx.hist && ctx.hist['.SPX']);
    if (isNum(ctx.spxNow) && ctx.spxNow > 0 && !hs[d]) hs[d] = ctx.spxNow;              // today's close, if the history has not caught up
    const rv = rvForecast(hs, B.lam);
    const done = st.closed.filter((c) => c.s === 'base').length, budget = done < B.startCycles ? B.startBudget : B.budget;
    const credit = sh[1] - lg[2], width = sh[0] - lg[0], worst = (width - credit) * 100;
    const gate = { date: d, iv: isNum(iv) ? r4(iv) : null, rv: isNum(rv) ? r4(rv) : null, budget, open: false };
    st.base = gate;
    if (!isNum(iv) || !isNum(rv)) { gate.why = '변동성 자료가 없어 쉽니다'; return; }
    if (!(iv > rv)) { gate.why = `옵션값(내재 변동성 ${(iv * 100).toFixed(1)}%)이 실제 흔들림 예측(${(rv * 100).toFixed(1)}%)보다 싸서 팔지 않습니다`; return; }
    if (!(credit > 0) || !(worst > 0)) { gate.why = '호가가 맞지 않아 쉽니다'; return; }
    const n = Math.min(Math.floor((acct * budget) / worst), Math.floor((acct * B.cap) / (sh[0] * 100)));
    if (n < 1) { gate.why = `한 계약의 최악 손실 $${worst.toFixed(0)}이 한도(계좌의 ${Math.round(budget * 100)}%)를 넘어 쉽니다`; return; }
    if (free(st) < n * width * 100) { gate.why = `담보로 묶을 현금(${usd(n * width * 100)})이 모자라 쉽니다`; return; }
    gate.open = true; gate.why = null;
    const why = `S&P 500 기반층: 옵션값(내재 변동성 ${(iv * 100).toFixed(1)}%)이 실제 흔들림 예측(${(rv * 100).toFixed(1)}%)보다 비싸 SPY ${sh[0]}풋을 팔고 ${lg[0]}풋을 삽니다(${e} 만기, ${n}계약). `
      + `받은 값 $${(credit * 100 * n).toFixed(0)}, 최악 손실 $${(worst * n).toFixed(0)}(계좌의 ${((worst * n) / acct * 100).toFixed(1)}%, 한도 ${Math.round(budget * 100)}%). 만기까지 들고 갑니다.`;
    openOpt(st, { side: 'base', und: 'SPY', right: 'P', exp: e, kShort: sh[0], kLong: lg[0], n, cost: -credit, spot: S, iv: r4(iv), rv: r4(rv), why }, now, d);
  }
  function manageOptions(st, ctx, night) {
    const chs = ctx.chain || {}, d = ctx.date, now = ctx.now, cio = ctx.cio || {}, O = cio.opt || {}, acct = Math.max(1, ctx.account || equity(st));
    RISK = { acct, spots: { SPY: (chs.SPY && chs.SPY.spot) || (ctx.px && ctx.px.SPY), IWM: (chs.IWM && chs.IWM.spot) || (ctx.px && ctx.px.IWM) } };
    const pxOf = (u) => (chs[u] && chs[u].spot) || (ctx.px && ctx.px[u]) || (u === 'SPY' ? ctx.spy : null);
    // 1. expiry at the intrinsic value; a short put ending in the money buys the shares (the strike in all), a covered
    //    call ending in the money sells them (the strike in all)
    for (const o of st.opt.slice()) {
      const u = o.und || 'SPY', spot = pxOf(u);
      if (!(o.exp <= d && spot > 0)) continue;
      closeOpt(st, o, intrinsic(o, spot), now, d, `만기(${u} ${spot.toFixed(2)})`, true);
      if (o.side === 'csp' && spot < o.k) stockBuy(st, u, o.n * 100, spot, now, d, `현금 담보 풋이 행사돼 ${u} ${o.n * 100}주를 ${o.k}에 산 셈입니다(옵션 정산 + 지금 값 ${spot.toFixed(2)}에 매수).`);
      if (o.side === 'cc' && spot > o.k) stockSell(st, u, o.n * 100, spot, now, d, `커버드콜이 행사돼 ${u} ${o.n * 100}주를 ${o.k}에 판 셈입니다.`);
    }
    for (const u in st.stk || {}) { const p = pxOf(u); if (p > 0) st.stk[u].px = p; }
    // 2. marks and exits
    for (const o of st.opt.slice()) {
      const ch = chs[o.und || 'SPY'];
      if (!ch || !ch.exps) continue;
      const mid = optMid(o, ch);
      if (mid != null) o.val = r4(mid);
      const left = days(d, o.exp), owe = -(o.val != null ? o.val : o.cost), got = -o.cost;   // buy-back cost and premium (short positions)
      let why = null;
      if (o.side === 'credit' || o.side === 'ccall') {
        const c = o.side === 'credit' ? CFG.credit : CFG.ccall, off = o.side === 'credit' ? cio.opt && !O.credit : cio.opt && O.callCredit === false;
        if (owe <= got * (1 - c.take)) why = `이익 실현(받은 프리미엄의 ${Math.round(c.take * 100)}%)`;
        else if (owe >= got * c.stopX) why = `손절(되사는 값이 받은 값의 ${c.stopX}배)`;
        else if (left <= c.exitDte) why = `만기 ${left}일 전 정리`;
        else if (off) why = 'AI 배분: 시장 국면이 바뀌어 프리미엄 매도를 쉼';
      } else if (o.side === 'lcall' || o.side === 'lput') {
        const c = CFG.longOpt, v = o.val != null ? o.val : o.cost;
        if (v >= o.cost * (1 + c.take)) why = `이익 실현(산 값의 ${Math.round((1 + c.take) * 100)}%)`;
        else if (v <= o.cost * (1 - c.stop)) why = `손절(산 값의 ${Math.round(c.stop * 100)}% 손실)`;
        else if (left <= c.exitDte) why = `만기 ${left}일 전 정리(시간 가치 소멸 전)`;
      } else if (o.side === 'ncall') {
        const c = CFG.nakedCall;
        if (owe <= got * (1 - c.take)) why = `이익 실현(받은 프리미엄의 ${Math.round(c.take * 100)}%)`;
        else if (owe >= got * c.stopX) why = `손절(되사는 값이 받은 값의 ${c.stopX}배)`;
        else if (left <= c.exitDte) why = `만기 ${left}일 전 정리`;
      } else if (o.side === 'hedge') {
        if (left <= CFG.hedge.exitDte) why = `만기 ${left}일 전 정리`;
        else if (cio.opt && !O.hedge) why = 'AI 배분: 위험 회피 국면이 끝나 보호를 풂';
      } else if (o.side === 'csp' || o.side === 'cc') {
        if (owe <= got * (1 - CFG.wheel.take)) why = `이익 실현(받은 프리미엄의 ${Math.round(CFG.wheel.take * 100)}%)`;
        else if (O.off) why = o.side === 'csp' ? 'AI 배분: 위험 회피 국면이라 주식을 떠안지 않도록 되삼' : 'AI 배분: 위험 회피 국면이라 콜을 되사고 주식을 정리';
      }
      if (why) closeOpt(st, o, null, now, d, why, false, ch);
    }
    // risk-off: the wheel's shares go once their call is bought back
    if (O.off) for (const u of Object.keys(st.stk || {})) {
      const p = pxOf(u);
      if (p > 0 && !st.opt.some((o) => o.side === 'cc' && (o.und || 'SPY') === u)) stockSell(st, u, st.stk[u].qty, p, now, d, 'AI 배분: 위험 회피 국면이라 휠 전략의 주식을 정리');
    }
    // 3. new positions (none on a day the whole account has lost its daily limit)
    if (ctx.brake) return;
    const spy = chs.SPY;
    if (spy && spy.exps && night && (O.longOpt || O.nakedCall)) openDirectional(st, spy, ctx, acct, O);
    if (spy && spy.exps && night && O.base && !st.opt.some((o) => o.side === 'base')) openBase(st, spy, ctx, acct);
    if (spy && spy.exps) {
      if (O.credit) openCreditSpread(st, spy, ctx, 'P', acct);
      if (O.callCredit) openCreditSpread(st, spy, ctx, 'C', acct);
      // a protective spread (the account's stocks, the market turning down)
      const hd = CFG.hedge, exp = ctx.exposure || 0;
      if (O.hedge && !st.opt.some((o) => o.side === 'hedge') && exp > 0) {
        const e = pickExp(spy, d, hd.dteMin, hd.dteMax, hd.dteAim);
        if (e) {
          const puts = legs(spy, e, 'P'), a = near(puts, hd.longDelta), b = near(puts, hd.shortDelta);
          const n = a && b ? Math.round(exp * (O.ratio || hd.ratio) / (spy.spot * 100 * Math.max(0.05, (-a[4]) - (-b[4])))) : 0;
          if (a && b && a[0] > b[0] && n >= 1) {
            const debit = a[2] - b[1];
            if (debit > 0 && free(st) > debit * 100 * n) openOpt(st, { side: 'hedge', und: 'SPY', right: 'P', exp: e, kLong: a[0], kShort: b[0], n, cost: debit, spot: spy.spot,
              why: `시장 위험 회피 국면: 계좌의 주식 등 ${usd(exp)}를 지키려고 SPY ${a[0]}풋 매수·${b[0]}풋 매도(보호 비율 ${Math.round((O.ratio || hd.ratio) * 100)}%)` }, now, d);
          }
        }
      }
    }
    // the wheel: covered calls on the shares held, a cash-secured put while it is on and nothing is held yet
    const W = CFG.wheel, u = W.und, wc = chs[u];
    if (wc && wc.exps && !O.off) {
      const x = st.stk && st.stk[u], held = x ? x.qty : 0;
      const lots = Math.floor(held / 100) - st.opt.filter((o) => o.side === 'cc' && o.und === u).reduce((t, o) => t + o.n, 0);
      if (lots >= 1) {
        const e = pickExp(wc, d, W.dteMin, W.dteMax, W.dteAim), sh = e && nearD(legs(wc, e, 'C').filter((r) => r[0] >= x.cost), W.callDelta, 'C');
        if (sh && sh[1] >= wc.spot * W.minPrem) openOpt(st, { side: 'cc', und: u, right: 'C', exp: e, k: sh[0], n: lots, cost: -sh[1], spot: wc.spot,
          why: `커버드콜: 들고 있는 ${u} ${lots * 100}주에 ${sh[0]}콜(델타 ${sh[4].toFixed(2)})을 팔아 $${(sh[1] * 100 * lots).toFixed(0)}를 받습니다. ${u}가 ${sh[0]} 위로 끝나면 그 값에 팔립니다(주식 평단 $${x.cost.toFixed(2)}).` }, now, d);
      }
      if (O.wheel && !held && !st.opt.some((o) => o.side === 'csp' && o.und === u)) {
        const e = pickExp(wc, d, W.dteMin, W.dteMax, W.dteAim), sh = e && nearD(legs(wc, e, 'P'), W.putDelta, 'P');
        if (sh && sh[1] >= sh[0] * W.minPrem && free(st) >= sh[0] * 100 && sh[0] * 100 <= acct * W.maxShare) openOpt(st, { side: 'csp', und: u, right: 'P', exp: e, k: sh[0], n: 1, cost: -sh[1], spot: wc.spot,
          why: `현금 담보 풋: ${u} ${sh[0]}풋(델타 ${sh[4].toFixed(2)})을 팔아 $${(sh[1] * 100).toFixed(0)}를 받습니다. 만기에 ${u}가 ${sh[0]} 아래면 100주를 그 값에 사고(실제로는 ${(sh[0] - sh[1]).toFixed(2)}에 산 셈), 그 뒤 커버드콜을 팝니다.` }, now, d);
      }
    }
  }
  // the S&P 500's trend from its closes: up (above a rising 50-day average), down (below a falling one), otherwise mixed
  function spxTrend(hs) {
    const p = Object.keys(hs).sort().map((k) => +hs[k]).filter((v) => v > 0);
    if (p.length < 200) return 'mixed';
    const avg = (n) => p.slice(-n).reduce((a, b) => a + b, 0) / n, S = p[p.length - 1], a50 = avg(50), a200 = avg(200);
    return S > a50 && a50 > a200 ? 'up' : S < a50 && a50 < a200 ? 'down' : 'mixed';
  }
  function openDirectional(st, ch, ctx, acct, O) {
    const d = ctx.date, now = ctx.now, S = ch.spot, rf = isNum(ctx.rf) ? ctx.rf : 0.04;
    const hs = Object.assign({}, ctx.hist && ctx.hist['.SPX']);
    if (isNum(ctx.spxNow) && ctx.spxNow > 0 && !hs[d]) hs[d] = ctx.spxNow;
    const rv = rvForecast(hs, CFG.base.lam), tr = spxTrend(hs);
    if (!(S > 0) || !isNum(rv)) return;
    const ivAt = (e, r) => { const rows = legs(ch, e, r).filter((x) => x[1] > 0 && x[2] > 0); const a = rows.sort((x, y) => Math.abs(x[0] - S) - Math.abs(y[0] - S))[0];
      return a ? (isNum(a[3]) && a[3] > 0 ? a[3] : r === 'P' ? ivFromPut(midOf(a), S, a[0], days(d, e) / 365, rf) : null) : null; };
    // buying: cheap options, with the trend
    const L = CFG.longOpt, side = tr === 'up' ? 'lcall' : tr === 'down' ? 'lput' : null;
    if (O.longOpt && side && !st.opt.some((o) => o.side === side)) {
      const r = side === 'lcall' ? 'C' : 'P', e = pickExp(ch, d, L.dteMin, L.dteMax, L.dteAim), iv = e && ivAt(e, r);
      const spent = st.opt.filter((o) => o.long).reduce((t, o) => t + o.n * 100 * o.cost, 0);
      if (e && isNum(iv) && iv < rv) {
        const row = nearD(legs(ch, e, r).filter((x) => x[2] > 0), L.delta, r);
        const n = row ? Math.min(Math.floor((acct * L.riskPer) / (row[2] * 100)), Math.floor((acct * L.maxRisk - spent) / (row[2] * 100))) : 0;
        if (row && n >= 1 && free(st) > row[2] * 100 * n) openOpt(st, { side, long: true, und: 'SPY', right: r, exp: e, k: row[0], n, cost: row[2], spot: S, iv: r4(iv), rv: r4(rv),
          why: `${side === 'lcall' ? '콜' : '풋'} 매수: S&P 500이 ${tr === 'up' ? '상승' : '하락'} 추세이고 옵션값(내재 변동성 ${(iv * 100).toFixed(1)}%)이 실제 흔들림 예측(${(rv * 100).toFixed(1)}%)보다 싸서 SPY ${row[0]}${side === 'lcall' ? '콜' : '풋'}(델타 ${Math.abs(row[4]).toFixed(2)}) ${n}계약을 삽니다. 최대 손실은 낸 값 $${(row[2] * 100 * n).toFixed(0)}, +100%면 이익 실현, −50%면 손절.` }, now, d);
      }
    }
    // selling a naked call: dear options, a market that is not rising
    const N = CFG.nakedCall;
    if (O.nakedCall && tr !== 'up' && !st.opt.some((o) => o.side === 'ncall')) {
      const e = pickExp(ch, d, N.dteMin, N.dteMax, N.dteAim), iv = e && ivAt(e, 'C');
      if (e && isNum(iv) && iv > rv && S * 100 <= acct * N.maxNotional) {
        const row = nearD(legs(ch, e, 'C').filter((x) => x[1] > 0 && x[0] > S), N.delta, 'C');
        const margin = row ? (Math.max(0.2 * S - (row[0] - S), 0.1 * S) + row[1]) * 100 : 0;
        if (row && free(st) >= margin) openOpt(st, { side: 'ncall', und: 'SPY', right: 'C', exp: e, k: row[0], n: 1, cost: -row[1], spot: S, margin: r2(margin), iv: r4(iv), rv: r4(rv),
          why: `콜 매도(무담보): 옵션값(내재 변동성 ${(iv * 100).toFixed(1)}%)이 실제 흔들림 예측(${(rv * 100).toFixed(1)}%)보다 비싸고 S&P 500이 오르는 추세가 아니라 SPY ${row[0]}콜(델타 ${row[4].toFixed(2)})을 팔아 $${(row[1] * 100).toFixed(0)}를 받습니다. 증거금 ${usd(margin)}, 되사는 값이 받은 값의 ${N.stopX}배가 되면 손절합니다.` }, now, d);
      }
    }
  }
  let RISK = null;   // { spots, acct } for the stress test, set by manageOptions
  function stressLoss(list, spots) {
    let down = 0, up = 0;
    for (const o of list) {
      if (o.long || o.side === 'hedge') continue;
      const S = spots[o.und || 'SPY'] || o.spot; if (!(S > 0)) continue;
      const loss = (x) => Math.max(0, -(intrinsic(o, x) - o.cost) * o.n * 100);
      if (rightOf(o) === 'P') down += loss(S * (1 - CFG.stress.move)); else up += loss(S * (1 + CFG.stress.move));
    }
    return Math.max(down, up);
  }
  function openOpt(st, o, now, d) {
    if (RISK && !o.long && o.side !== 'hedge') {
      const now0 = stressLoss(st.opt, RISK.spots), next = stressLoss(st.opt.concat([o]), RISK.spots);
      if (next > CFG.stress.max * RISK.acct && next > now0) { st.stressNote = { date: d, side: o.side, loss: r2(next), cap: r2(CFG.stress.max * RISK.acct) }; return false; }
    }
    const fee = r2(o.n * (single(o) ? 1 : 2) * CFG.optFee);
    st.cash = r2(st.cash - o.n * 100 * o.cost - fee); st.fees = r2(st.fees + fee);
    const id = 'o' + (++st.seq);
    o.cost = r4(o.cost);
    st.opt.push(Object.assign({ id, date: d, t: now, val: o.cost, fees: fee }, o));
    fill(st, { t: now, date: d, kind: 'opt', id, name: optName(o), side: o.side === 'hedge' || o.long ? 'buy' : 'sell', qty: o.n, px: r4(Math.abs(o.cost)), fee, why: o.why });
  }
  function closeOpt(st, o, value, now, d, why, expired, ch) {
    let v = value;
    if (v == null) {                       // a short position is bought back at the ask, a long one sold at the bid
      const r = rightOf(o);
      if (single(o)) { const row = rowAt(ch, o.exp, r, o.k); v = o.long ? (row && row[1] >= 0 ? row[1] : (o.val != null ? o.val : o.cost)) : row && row[2] > 0 ? -row[2] : (o.val != null ? o.val : o.cost); }
      else { const L = rowAt(ch, o.exp, r, o.kLong), S = rowAt(ch, o.exp, r, o.kShort); v = L && S && L[1] >= 0 && S[2] > 0 ? L[1] - S[2] : (o.val != null ? o.val : o.cost); }
    }
    const fee = expired ? 0 : r2(o.n * (single(o) ? 1 : 2) * CFG.optFee);
    st.cash = r2(st.cash + o.n * 100 * v - fee); st.fees = r2(st.fees + fee);
    const pnl = r2(o.n * 100 * (v - o.cost) - (o.fees || 0) - fee);
    fill(st, { t: now, date: d, kind: 'opt', id: o.id, name: optName(o), side: o.side === 'hedge' || o.long ? 'sell' : 'buy', qty: o.n, px: r4(Math.abs(v)), fee, pnl, why });
    st.closed.push({ kind: 'opt', s: o.side, id: o.id, und: o.und || 'SPY', exp: o.exp, k: o.k, kLong: o.kLong, kShort: o.kShort, n: o.n, from: o.date, to: d, pnl, why });
    st.opt = st.opt.filter((x) => x !== o);
  }
  function session(st, ctx) {
    if (!st.date) return;
    for (const k in st.fut) {
      const p = st.fut[k], q = (ctx.fut || {})[k];
      const px = q && q.c1 && q.c1.contract === p.contract ? q.c1.px : q && q.c2 && q.c2.contract === p.contract ? q.c2.px : null;
      if (px > 0) p.px = px;
    }
    manageOptions(st, Object.assign({}, ctx, { date: ctx.today || ctx.date }), false);
    st.at = ctx.now;
  }

  // ── ELS
  function elsParams(ctx) {
    const v1 = isNum(ctx.vix) ? 0.5 * ctx.vix / 100 + 0.5 * 0.18 : 0.2, v2 = isNum(ctx.vxn) ? 0.5 * ctx.vxn / 100 + 0.5 * 0.23 : 0.26;
    const r = isNum(ctx.y2) ? ctx.y2 / 100 : 0.04;
    return { sig: [v1, v2], rho: isNum(ctx.rho) ? Math.min(0.97, Math.max(0.5, ctx.rho)) : 0.9, r, q: [CFG.els.qSpx, CFG.els.qNdx] };
  }
  function elsTerms(d) { return CFG.els.obs.map((b, i) => [addMonths(d, 6 * (i + 1)), b]); }
  function manageEls(st, ctx) {
    const d = ctx.date, now = ctx.now, E = CFG.els, cio = ctx.cio || {};
    if (!(ctx.spx > 0 && ctx.ndx > 0)) return;
    for (const e of st.els.slice()) {
      const w = Math.min(ctx.spx / e.s0[0], ctx.ndx / e.s0[1]);
      if (w <= e.ki && !e.kiHit) { e.kiHit = d; note(st, now, 'els', `ELS ${e.id} 낙인 발생: 두 지수 중 낮은 쪽이 시작 대비 ${(w * 100).toFixed(1)}%`); }
      const due = e.obs.filter(([od]) => od <= d && !(e.seen || []).includes(od));
      let gone = false;
      for (const [od, b] of due) {
        e.seen = (e.seen || []).concat(od);
        const last = od === e.obs[e.obs.length - 1][0], yrs = days(e.date, od) / 365;
        if (w >= b || (last && !e.kiHit)) { redeemEls(st, e, 1 + e.coupon * yrs, now, d, `${last ? '만기' : '조기'} 상환: 평가일 ${od}, 낮은 지수 ${(w * 100).toFixed(1)}% ≥ 기준 ${Math.round(b * 100)}%${last && w < b ? ' (낙인 없이 만기)' : ''}`); gone = true; break; }
        if (last) { redeemEls(st, e, w, now, d, `만기 손실 상환: 낙인 후 낮은 지수 ${(w * 100).toFixed(1)}%`); gone = true; break; }
      }
      if (gone) continue;
      const p = elsParams(ctx), t0 = days(e.date, d) / 365;
      const obsY = e.obs.map(([od, b]) => [days(e.date, od) / 365, b]);
      const val = elsValue(Object.assign({ perf: [ctx.spx / e.s0[0], ctx.ndx / e.s0[1]], t0, obs: obsY.filter(([t]) => t > t0), ki: e.ki, kiHit: !!e.kiHit, T: obsY[obsY.length - 1][0], paths: E.markPaths, seed: hash(e.id + d) }, p));
      e.val = r4(val.A + e.coupon * val.B); e.pCall = r4(val.pCall); e.pKi = r4(val.pKi); e.w = r4(w);
    }
    // a new issue: once a month at most, inside the AI's ELS budget
    const acct = Math.max(1, ctx.account || equity(st)), lastBuy = st.els.length ? st.els[st.els.length - 1].date : st.lastEls;
    if (cio.els && cio.els.on && (!lastBuy || days(lastBuy, d) >= 28)) {
      const held = st.els.reduce((a, e) => a + e.amount, 0), cap = acct * (cio.els.max || 0.1);
      if (held + E.lot <= cap && free(st) > E.lot * 1.2) {
        const p = elsParams(ctx), obs = elsTerms(d).map(([od, b]) => [days(d, od) / 365, b]);
        const v = elsValue(Object.assign({ perf: [1, 1], t0: 0, obs, ki: E.ki, kiHit: false, T: obs[obs.length - 1][0], paths: E.paths, seed: hash('issue' + d) }, p));
        const coupon = (E.fvTarget - v.A) / v.B;
        if (coupon >= (cio.els.minCoupon || 0.07)) {
          const id = 'els' + (++st.seq), c = Math.floor(coupon * 1000) / 1000;
          st.els.push({ id, date: d, t: now, amount: E.lot, s0: [ctx.spx, ctx.ndx], coupon: c, ki: E.ki, obs: elsTerms(d), val: E.fvTarget, pCall: r4(v.pCall), pKi: r4(v.pKi), vol: p.sig.map(r4), rho: r4(p.rho),
            why: `S&P 500·나스닥 100 스텝다운 ELS(3년, 6개월마다 조기상환 90-90-85-85-80-75, 낙인 45%) 연 ${(c * 100).toFixed(1)}%. 변동성이 높아(VIX ${ctx.vix.toFixed(1)}, VXN ${isNum(ctx.vxn) ? ctx.vxn.toFixed(1) : '-'}) 쿠폰이 높을 때 한도(${Math.round((cio.els.max || 0.1) * 100)}%) 안에서 삽니다. 모형상 조기상환 확률 ${Math.round(v.pCall * 100)}%, 낙인 확률 ${Math.round(v.pKi * 100)}%` });
          st.cash = r2(st.cash - E.lot); st.lastEls = d;
          fill(st, { t: now, date: d, kind: 'els', id, name: `ELS ${id} (S&P 500·나스닥 100, 연 ${(c * 100).toFixed(1)}%)`, side: 'buy', qty: 1, px: E.lot, fee: 0, why: st.els[st.els.length - 1].why });
        }
      }
    }
  }
  function redeemEls(st, e, per1, now, d, why) {
    const got = r2(e.amount * per1);
    st.cash = r2(st.cash + got);
    const pnl = r2(got - e.amount);
    fill(st, { t: now, date: d, kind: 'els', id: e.id, name: `ELS ${e.id}`, side: 'sell', qty: 1, px: got, fee: 0, pnl, why });
    st.closed.push({ kind: 'els', s: 'els', id: e.id, from: e.date, to: d, pnl, why });
    st.els = st.els.filter((x) => x !== e);
  }

  // ── what the page shows
  function view(st) {
    const sdOf = (k) => (st.signals && st.signals[k] && st.signals[k].vol) || null;
    const fut = Object.values(st.fut).map((p) => ({ key: p.key, name: p.name, g: p.g, qty: p.qty, contract: p.contract, exp: p.exp, entry: p.entry, px: p.px,
      stop: p.best && sdOf(p.key) ? r4(p.qty > 0 ? p.best * (1 - CFG.cta.stopK * sdOf(p.key)) : p.best * (1 + CFG.cta.stopK * sdOf(p.key))) : null,
      notional: r2(Math.abs(p.qty) * p.px * p.mult), margin: r2(Math.abs(p.qty) * p.px * p.mult * FUT_BY[p.key].mr), pnl: r2((p.real || 0) + p.qty * p.mult * (p.px - p.mark) - (p.feesPaid || 0)), date: p.date, why: p.why }));
    const maxLossOf = (o) => (o.side === 'credit' || o.side === 'base' ? o.n * 100 * (o.kShort - o.kLong + o.cost) : o.side === 'ccall' ? o.n * 100 * (o.kLong - o.kShort + o.cost)
      : o.side === 'csp' ? o.n * 100 * (o.k + o.cost) : o.side === 'cc' || o.side === 'ncall' ? null : o.n * 100 * o.cost);
    const opt = st.opt.map((o) => ({ id: o.id, side: o.side, und: o.und || 'SPY', right: rightOf(o), exp: o.exp, k: o.k, kLong: o.kLong, kShort: o.kShort, n: o.n, cost: o.cost, val: o.val, margin: o.margin,
      value: r2(o.n * 100 * (o.val != null ? o.val : o.cost)), pnl: r2(o.n * 100 * ((o.val != null ? o.val : o.cost) - o.cost) - (o.fees || 0)),
      maxLoss: maxLossOf(o) != null ? r2(maxLossOf(o)) : null, date: o.date, why: o.why }));
    const stk = Object.values(st.stk || {}).map((x) => ({ sym: x.sym, qty: x.qty, cost: r4(x.cost), px: x.px, value: r2(x.qty * x.px), pnl: r2((x.px - x.cost) * x.qty), since: x.since }));
    const els = st.els.map((e) => ({ id: e.id, amount: e.amount, coupon: e.coupon, date: e.date, s0: e.s0, ki: e.ki, kiHit: e.kiHit || null, obs: e.obs, next: (e.obs.find(([od]) => !(e.seen || []).includes(od)) || [])[0] || null,
      w: e.w || null, val: e.val, value: r2(e.amount * (e.val != null ? e.val : 1)), pCall: e.pCall, pKi: e.pKi, why: e.why }));
    const by = {};
    for (const c of st.closed) { const b = (by[c.s] = by[c.s] || { n: 0, wins: 0, pnl: 0 }); b.n++; if (c.pnl > 0) b.wins++; b.pnl = r2(b.pnl + c.pnl); }
    return { v: 1, at: st.at, date: st.date, funded: st.funded, cash: st.cash, eq: equity(st), margin: marginUsed(st), optRisk: r2(optRisk(st)), rp: st.rp, fees: st.fees,
      fut, opt, els, stk, by, base: st.base || null, stress: { move: CFG.stress.move, max: CFG.stress.max, loss: r2(stressLoss(st.opt, (RISK && RISK.spots) || {})), note: st.stressNote || null }, signals: st.signals || {}, fills: st.fills.slice(-120).reverse(), hist: st.hist.slice(-400), log: st.log.slice(-40).reverse(), transfers: st.transfers };
  }

  const api = { FUT, FUT_BY, GROUP_NAME, CFG, init, fund, nightly, session, view, equity, marginUsed, free, elsValue, bsPut, trend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deriv = api;
})(typeof self !== 'undefined' ? self : this);
