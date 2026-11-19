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
  function optMid(o, ch) {           // a put spread's value per spread (long − short) from the chain, else the last mark
    const q = ch && ch.exps && ch.exps[o.exp];
    const get = (K) => { const r = q && q.puts.find((x) => x[0] === K); return r && r[1] >= 0 && r[2] > 0 ? (r[1] + r[2]) / 2 : null; };
    const a = get(o.kLong), b = get(o.kShort);
    return a != null && b != null ? a - b : null;
  }
  function equity(st) {
    let v = st.cash;
    for (const k in st.fut) { const p = st.fut[k]; v += p.qty * p.mult * (p.px - p.mark); }
    for (const o of st.opt) v += o.n * 100 * (o.val != null ? o.val : o.cost);
    for (const e of st.els) v += e.amount * (e.val != null ? e.val : 1);
    return r2(v);
  }
  function marginUsed(st) { let m = 0; for (const k in st.fut) { const p = st.fut[k], f = FUT_BY[k]; m += Math.abs(p.qty) * p.px * f.mult * f.mr; } return r2(m); }
  function optRisk(st) { let m = 0; for (const o of st.opt) if (o.side === 'credit') m += o.n * 100 * (o.kShort - o.kLong); return m; }
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
    const cands = FUT.filter((f) => !st.fut[f.key] && sig[f.key] && Math.abs(sig[f.key].s) === 1).map((f) => ({ f, t: sig[f.key], dir: Math.sign(sig[f.key].s) }))
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

  // ── options: SPY put spreads. ch: {spot, at, exps: {YYYY-MM-DD: {puts: [[K, bid, ask, iv, delta]]}}}
  function pickExp(ch, d, lo, hi, aim) {
    const ok = Object.keys((ch && ch.exps) || {}).filter((e) => { const n = days(d, e); return n >= lo && n <= hi; });
    return ok.sort((a, b) => Math.abs(days(d, a) - aim) - Math.abs(days(d, b) - aim))[0] || null;
  }
  const near = (puts, delta) => puts.filter((r) => isNum(r[4]) && r[4] < 0 && r[1] > 0 && r[2] > 0).sort((a, b) => Math.abs(-a[4] - delta) - Math.abs(-b[4] - delta))[0];
  function manageOptions(st, ctx, night) {
    const ch = ctx.chain && ctx.chain.SPY, d = ctx.date, now = ctx.now, cio = ctx.cio || {}, acct = Math.max(1, ctx.account || equity(st));
    // expiry: settle at the intrinsic value with the last SPY price
    for (const o of st.opt.slice()) {
      const spot = (ch && ch.spot) || ctx.spy;
      if (o.exp <= d && spot > 0) {
        const v = Math.max(0, o.kLong - spot) - Math.max(0, o.kShort - spot);
        closeOpt(st, o, v, now, d, `만기(SPY ${spot.toFixed(2)})`, true);
      }
    }
    if (!ch || !ch.exps) return;
    // marks and exits
    for (const o of st.opt.slice()) {
      const mid = optMid(o, ch);
      if (mid != null) o.val = r4(mid);
      const left = days(d, o.exp);
      if (o.side === 'credit') {
        const debit = -(o.val != null ? o.val : o.cost);             // what it costs to buy the spread back
        const credit = -o.cost;
        let why = null;
        if (debit <= credit * (1 - CFG.credit.take)) why = `이익 실현(받은 프리미엄의 ${Math.round(CFG.credit.take * 100)}%)`;
        else if (debit >= credit * CFG.credit.stopX) why = `손절(되사는 값이 받은 값의 ${CFG.credit.stopX}배)`;
        else if (left <= CFG.credit.exitDte) why = `만기 ${left}일 전 정리`;
        else if (cio.opt && !cio.opt.credit) why = 'AI 배분: 시장 국면이 바뀌어 프리미엄 매도를 쉼';
        if (why) closeOpt(st, o, null, now, d, why, false, ch);
      } else {
        let why = null;
        if (left <= CFG.hedge.exitDte) why = `만기 ${left}일 전 정리`;
        else if (cio.opt && !cio.opt.hedge) why = 'AI 배분: 위험 회피 국면이 끝나 보호를 풂';
        if (why) closeOpt(st, o, null, now, d, why, false, ch);
      }
    }
    // new credit spread (income in an uptrend with rich premiums)
    const cr = CFG.credit;
    if (cio.opt && cio.opt.credit) {
      const open = st.opt.filter((o) => o.side === 'credit'), used = optRisk(st);
      const e = pickExp(ch, d, cr.dteMin, cr.dteMax, cr.dteAim);
      if (e && !open.some((o) => o.exp === e) && used < acct * cr.maxRisk) {
        const puts = ch.exps[e].puts, s = near(puts, cr.delta);
        const l = s && puts.find((r) => Math.abs(r[0] - (s[0] - cr.width)) < 1e-9 && r[2] > 0);
        if (s && l) {
          const credit = s[1] - l[2], width = s[0] - l[0];          // sell at the bid, buy at the ask
          if (credit >= width * cr.minCreditPct) {
            const n = Math.max(0, Math.min(Math.floor(acct * cr.riskPer / ((width - credit) * 100)), Math.floor((acct * cr.maxRisk - used) / ((width - credit) * 100))));
            if (n >= 1 && free(st) > n * width * 100) openOpt(st, { side: 'credit', exp: e, kShort: s[0], kLong: l[0], n, cost: -credit, spot: ch.spot,
              why: `S&P 500 상승 추세에 옵션 프리미엄이 높아(VIX ${isNum(ctx.vix) ? ctx.vix.toFixed(1) : '-'}) 풋 스프레드를 팝니다. SPY ${s[0]}풋 매도(델타 ${s[4].toFixed(2)})·${l[0]}풋 매수, 받은 값 $${credit.toFixed(2)} (최대 손실 $${((width - credit) * 100 * n).toFixed(0)})` }, now, d);
          }
        }
      }
    }
    // new protective spread (the account's stocks, the market turning down)
    const hd = CFG.hedge, exp = ctx.exposure || 0;
    if (cio.opt && cio.opt.hedge && !st.opt.some((o) => o.side === 'hedge') && exp > 0) {
      const e = pickExp(ch, d, hd.dteMin, hd.dteMax, hd.dteAim);
      if (e) {
        const puts = ch.exps[e].puts, a = near(puts, hd.longDelta), b = near(puts, hd.shortDelta);
        const n = a && b ? Math.round(exp * (cio.opt.ratio || hd.ratio) / (ch.spot * 100 * Math.max(0.05, (-a[4]) - (-b[4])))) : 0;
        if (a && b && a[0] > b[0] && n >= 1) {
          const debit = a[2] - b[1];
          if (debit > 0 && free(st) > debit * 100 * n) openOpt(st, { side: 'hedge', exp: e, kLong: a[0], kShort: b[0], n, cost: debit, spot: ch.spot,
            why: `시장 위험 회피 국면: 계좌의 주식 등 ${usd(exp)}를 지키려고 SPY ${a[0]}풋 매수·${b[0]}풋 매도(보호 비율 ${Math.round((cio.opt.ratio || hd.ratio) * 100)}%)` }, now, d);
        }
      }
    }
  }
  function openOpt(st, o, now, d) {
    const fee = r2(o.n * 2 * CFG.optFee);
    st.cash = r2(st.cash - o.n * 100 * o.cost - fee); st.fees = r2(st.fees + fee);
    const id = 'o' + (++st.seq);
    st.opt.push(Object.assign({ id, date: d, t: now, val: o.cost, fees: fee }, o));
    fill(st, { t: now, date: d, kind: 'opt', id, name: `SPY ${o.exp.slice(2).replace(/-/g, '')} ${o.kLong}/${o.kShort} 풋 스프레드`, side: o.side === 'credit' ? 'sell' : 'buy', qty: o.n, px: r4(Math.abs(o.cost)), fee, why: o.why });
  }
  function closeOpt(st, o, value, now, d, why, expired, ch) {
    let v = value;
    if (v == null) {                       // buy back a credit spread at the ask/bid, sell a debit spread at the bid/ask
      const q = ch && ch.exps && ch.exps[o.exp];
      const row = (K) => q && q.puts.find((x) => x[0] === K);
      const L = row(o.kLong), S = row(o.kShort);
      v = L && S && L[1] >= 0 && S[2] > 0 ? L[1] - S[2] : (o.val != null ? o.val : o.cost);   // sell the long put at the bid, buy the short put back at the ask
    }
    const fee = expired ? 0 : r2(o.n * 2 * CFG.optFee);
    st.cash = r2(st.cash + o.n * 100 * v - fee); st.fees = r2(st.fees + fee);
    const pnl = r2(o.n * 100 * (v - o.cost) - (o.fees || 0) - fee);
    fill(st, { t: now, date: d, kind: 'opt', id: o.id, name: `SPY ${o.exp.slice(2).replace(/-/g, '')} ${o.kLong}/${o.kShort} 풋 스프레드`, side: o.side === 'credit' ? 'buy' : 'sell', qty: o.n, px: r4(Math.abs(v)), fee, pnl, why });
    st.closed.push({ kind: 'opt', s: o.side, id: o.id, exp: o.exp, kLong: o.kLong, kShort: o.kShort, n: o.n, from: o.date, to: d, pnl, why });
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
    const opt = st.opt.map((o) => ({ id: o.id, side: o.side, exp: o.exp, kLong: o.kLong, kShort: o.kShort, n: o.n, cost: o.cost, val: o.val, value: r2(o.n * 100 * (o.val != null ? o.val : o.cost)),
      pnl: r2(o.n * 100 * ((o.val != null ? o.val : o.cost) - o.cost) - (o.fees || 0)), maxLoss: r2(o.side === 'credit' ? o.n * 100 * (o.kShort - o.kLong + o.cost) : o.n * 100 * o.cost), date: o.date, why: o.why }));
    const els = st.els.map((e) => ({ id: e.id, amount: e.amount, coupon: e.coupon, date: e.date, s0: e.s0, ki: e.ki, kiHit: e.kiHit || null, obs: e.obs, next: (e.obs.find(([od]) => !(e.seen || []).includes(od)) || [])[0] || null,
      w: e.w || null, val: e.val, value: r2(e.amount * (e.val != null ? e.val : 1)), pCall: e.pCall, pKi: e.pKi, why: e.why }));
    const by = {};
    for (const c of st.closed) { const b = (by[c.s] = by[c.s] || { n: 0, wins: 0, pnl: 0 }); b.n++; if (c.pnl > 0) b.wins++; b.pnl = r2(b.pnl + c.pnl); }
    return { v: 1, at: st.at, date: st.date, funded: st.funded, cash: st.cash, eq: equity(st), margin: marginUsed(st), optRisk: r2(optRisk(st)), rp: st.rp, fees: st.fees,
      fut, opt, els, by, signals: st.signals || {}, fills: st.fills.slice(-120).reverse(), hist: st.hist.slice(-400), log: st.log.slice(-40).reverse(), transfers: st.transfers };
  }

  const api = { FUT, FUT_BY, GROUP_NAME, CFG, init, fund, nightly, session, view, equity, marginUsed, free, elsValue, bsPut, trend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deriv = api;
})(typeof self !== 'undefined' ? self : this);
