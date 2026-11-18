/* 자동매매 연습장 엔진 v2
   Paper-trading engine with risk management and a self-correction module.
   Pure functions over daily closes plus intraday price samples: the same input always gives the same trades, so the
   whole account can be rebuilt from the price files at any time. v2 adds intraday stop checks (prices sampled about
   every 15 minutes during the session) and a provisional "today" while the market is open: stops act at once, a loss
   is reviewed as soon as it happens, and new buys wait for the closing prices. Runs in node and in the browser. */
(function (root) {
  'use strict';

  // ── Rules the system may adjust by itself, with their starting values and hard limits ─────────────────
  const DEFAULTS = {
    stopK_bo: 2.0,      // breakout: initial stop = entry − k × daily price swing
    stopK_pb: 2.5,      // pullback: same
    trailK: 3.0,        // breakout: trailing stop = highest close since entry − k × daily price swing
    boLookback: 50,     // breakout: close above the highest close of the previous N trading days
    rsMin: 70,          // breakout: 6-month return must rank in the top (100 − x)% of the universe
    pbRsMin: 80,        // pullback: same, stricter
    pbRsi: 10,          // pullback: 2-day RSI below this
    regimeLevel: 1,     // market filter: 0 none · 1 S&P > 200d · 2 also > 50d · 3 also calm volatility
    maxPosW: 0.15,      // one position at most this share of the account
  };
  const BOUNDS = {
    stopK_bo: [1.5, 3.5], stopK_pb: [1.5, 3.5], trailK: [2.0, 4.5], boLookback: [20, 120], rsMin: [50, 90],
    pbRsMin: [60, 95], pbRsi: [3, 20], regimeLevel: [0, 3], maxPosW: [0.08, 0.20],
  };
  const LABELS = {
    stopK_bo: '돌파 매매 손절 폭', stopK_pb: '눌림목 매매 손절 폭', trailK: '추적 손절 폭',
    boLookback: '돌파 기준 기간', rsMin: '돌파 매매 최소 상대강도', pbRsMin: '눌림목 매매 최소 상대강도',
    pbRsi: '눌림목 과매도 기준', regimeLevel: '시장 필터 단계', maxPosW: '종목당 최대 비중',
  };
  const UNITS = {
    stopK_bo: '변동폭 ×', stopK_pb: '변동폭 ×', trailK: '변동폭 ×', boLookback: '거래일', rsMin: '백분위',
    pbRsMin: '백분위', pbRsi: 'RSI(2) 미만', regimeLevel: '단계', maxPosW: '%',
  };
  // Fixed risk rules (never changed by the system)
  const FIXED = {
    riskPct: 0.0075, maxPositions: 10, heatMax: 0.06, sectorMax: 3, maxNewPerDay: 3,
    timeStop_bo: 25, timeStop_pb: 8, slip: 0.001,
    dailyLossStop: 0.025, ddHalf: 0.08, ddStop: 0.15, ddResume: 0.10,
    cooldown: 10, cooldownGap: 30, reviewDays: 10,
    validateEvery: 20, validateWindow: 120, validateMargin: 0.03, minValue: 0.005,
  };
  const PB_NAME = { bo: '신고가 돌파', pb: '추세 눌림목' };

  const SPLITS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 10, 1 / 12, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50, 2 / 3, 3 / 2];
  const nearestSplit = (v) => SPLITS.reduce((b, c) => (Math.abs(v / c - 1) < Math.abs(v / b - 1) ? c : b), SPLITS[0]);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, d) => { const m = Math.pow(10, d); return Math.round(v * m) / m; };
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  // ── 1. Data: merge the static history with the daily snapshots collected since ─────────────────────────
  // seed: {dates, spx, syms:[{s,n,sec,c,e}], excl?};  live: {meta:{SYM:[name, sector]}, days:[{date, spx, rows:{SYM:[close, pct, capB]}}]}
  const companyKey = (n) => String(n || '').toLowerCase().replace(/\b(class [a-c]|common stock|ordinary shares?|inc\.?|corp(oration)?\.?|ltd\.?|plc|n\.?v\.?|s\.?a\.?|holdings?|co\.?|the)\b/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  // intra: {DATE: [{t: 'HH:MM', px: {SYM: price}}]} raw prices of the stocks held, sampled during the session
  function prepare(seed, live, intra) {
    const dates = seed.dates.slice();
    const times = [];
    const splitAdj = [];
    const spx = seed.spx.map((v) => (isNum(v) ? v : NaN));
    const S = seed.syms.map((x) => ({ s: x.s, n: x.n, sec: x.sec || '기타', c: x.c.map((v) => (isNum(v) ? v : NaN)), e: Array.from(x.e, (ch) => (ch === '1' ? 1 : 0)) }));
    const bySym = new Map(S.map((x, i) => [x.s, i]));
    const excl = new Set(seed.excl || []);
    const known = new Set(S.map((x) => companyKey(x.n)));
    const meta = (live && live.meta) || {};
    const lastRaw = S.map((x) => { for (let i = x.c.length - 1; i >= 0; i--) if (isNum(x.c[i])) return x.c[i]; return NaN; });
    const notes = [];
    const lastSeed = dates[dates.length - 1];
    const liveList = Array.isArray(live) ? live : (live && live.days) || [];
    const days = liveList.filter((d) => d && d.date > lastSeed && d.rows).sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const day of days) {
      if (dates.includes(day.date)) continue;
      dates.push(day.date);
      const t = dates.length - 1;
      times[t] = day.t || null;
      for (const x of S) { x.c.push(NaN); x.e.push(0); }
      for (const sym in day.rows) {
        const r = day.rows[sym];
        if (!Array.isArray(r) || !isNum(r[0]) || r[0] <= 0) continue;
        let i = bySym.get(sym);
        if (i === undefined) {
          if (!(r[2] >= 20) || excl.has(sym)) continue;      // a new large company: track it from today
          const m = meta[sym] || [sym, '기타'];
          if (known.has(companyKey(m[0]))) { excl.add(sym); continue; }   // another share class of a company already tracked
          known.add(companyKey(m[0]));
          i = S.length; bySym.set(sym, i);
          S.push({ s: sym, n: m[0] || sym, sec: m[1] || '기타', c: new Array(t + 1).fill(NaN), e: new Array(t + 1).fill(0) });
          lastRaw.push(NaN);
        }
        const x = S[i];
        const px = r[0], pct = r[1];
        // split check: the raw price jump is a clean split ratio, either after removing the exchange's reported
        // change or by itself (the exchange does not always adjust its own % change on the split day)
        if (isNum(lastRaw[i])) {
          const raw = px / lastRaw[i];
          const rep = isNum(pct) ? 1 + pct / 100 : NaN;
          const f = isNum(rep) ? raw / rep : NaN;
          const nearF = isNum(f) ? nearestSplit(f) : NaN, nearR = nearestSplit(raw);
          let factor = NaN;
          if (isNum(f) && Math.abs(f - 1) > 0.15 && Math.abs(f / nearF - 1) < 0.06) factor = nearF;
          else if (Math.abs(Math.log(raw)) > Math.log(1.8) && Math.abs(raw / nearR - 1) < 0.03) factor = nearR;
          if (isNum(factor)) {
            for (let j = 0; j < t; j++) if (isNum(x.c[j])) x.c[j] *= factor;
            notes.push({ date: day.date, sym, split: round(1 / factor, 3) });
            splitAdj.push({ sym, t, factor });
          }
        }
        x.c[t] = px; lastRaw[i] = px;
        x.e[t] = (r[2] >= 20 && px >= 5) ? 1 : 0;
      }
      spx.push(isNum(day.spx) ? day.spx : NaN);
    }
    // S&P 500 missing on a day: extend it with the cap-weighted move of the universe
    for (let t = 1; t < dates.length; t++) {
      if (isNum(spx[t])) continue;
      let num = 0, den = 0;
      for (const x of S) {
        const a = x.c[t - 1], b = x.c[t];
        if (x.e[t] && isNum(a) && isNum(b)) { num += b / a - 1; den += 1; }
      }
      spx[t] = spx[t - 1] * (1 + (den ? num / den : 0));
      notes.push({ date: dates[t], spxProxy: true });
    }
    // the last day is provisional while the market is still open (prices from the latest intraday snapshot)
    const lastDay = days[days.length - 1];
    const prov = lastDay && lastDay.src === 'intraday' && !lastDay.final && dates[dates.length - 1] === lastDay.date
      ? { t: dates.length - 1, time: lastDay.t || null } : null;
    // intraday samples aligned to day indexes, put on the same split-adjusted scale as the closes
    const intraArr = new Array(dates.length).fill(null);
    if (intra) {
      for (const dt in intra) {
        const t = dates.indexOf(dt);
        if (t < 0 || !Array.isArray(intra[dt])) continue;
        intraArr[t] = intra[dt].filter((s) => s && s.px && s.t).map((s) => ({ t: s.t, px: Object.assign({}, s.px) })).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      }
      for (const a of splitAdj) for (let j = 0; j < a.t; j++) { const sm = intraArr[j]; if (sm) for (const s of sm) if (isNum(s.px[a.sym])) s.px[a.sym] *= a.factor; }
    }
    const D = { dates, spx, S, notes, liveDays: days.length, intra: intraArr, times, prov };
    indicators(D);
    return D;
  }

  function sma(a, n) {
    const out = new Float64Array(a.length).fill(NaN);
    let s = 0, k = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!isNum(v)) { s = 0; k = 0; continue; }       // restart after a gap
      s += v; k++;
      if (k > n) { s -= a[i - n]; k = n; }
      if (k === n) out[i] = s / n;
    }
    return out;
  }

  function indicators(D) {
    const T = D.dates.length;
    for (const x of D.S) {
      const c = x.c;
      // forward-filled copy for return maths across a one-day hole
      const f = new Float64Array(T); let last = NaN;
      for (let t = 0; t < T; t++) { if (isNum(c[t])) last = c[t]; f[t] = last; }
      x.sma5 = sma(f, 5); x.sma50 = sma(f, 50); x.sma200 = sma(f, 200);
      // daily volatility: stdev of log returns over 20 days
      x.vol = new Float64Array(T).fill(NaN);
      for (let t = 21; t < T; t++) {
        let s = 0, s2 = 0, k = 0;
        for (let j = t - 19; j <= t; j++) {
          if (isNum(f[j]) && isNum(f[j - 1])) { const r = Math.log(f[j] / f[j - 1]); s += r; s2 += r * r; k++; }
        }
        if (k >= 15) x.vol[t] = Math.sqrt(Math.max(0, s2 / k - (s / k) * (s / k)));
      }
      // dominance: how many previous closes in a row this close beats (N-day breakout ⇔ dom ≥ N)
      x.dom = new Int16Array(T); const st = [];
      for (let t = 0; t < T; t++) {
        if (!isNum(f[t])) { x.dom[t] = 0; continue; }
        while (st.length && f[st[st.length - 1]] < f[t]) st.pop();
        x.dom[t] = Math.min(32000, st.length ? t - st[st.length - 1] - 1 : t);
        st.push(t);
      }
      x.ret126 = new Float64Array(T).fill(NaN);
      for (let t = 126; t < T; t++) if (isNum(f[t]) && isNum(f[t - 126])) x.ret126[t] = f[t] / f[t - 126] - 1;
      // RSI(2), Wilder
      x.rsi2 = new Float64Array(T).fill(NaN);
      let ag = NaN, al = NaN;
      for (let t = 1; t < T; t++) {
        if (!isNum(f[t]) || !isNum(f[t - 1])) continue;
        const ch = f[t] - f[t - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
        if (!isNum(ag)) { ag = g; al = l; } else { ag = (ag * 1 + g) / 2; al = (al * 1 + l) / 2; }
        x.rsi2[t] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
      x.f = f;
    }
    // relative strength percentile among the day's eligible stocks
    for (const x of D.S) x.rs = new Uint8Array(T);
    for (let t = 0; t < T; t++) {
      const list = [];
      for (const x of D.S) if (x.e[t] && isNum(x.ret126[t])) list.push(x);
      list.sort((a, b) => a.ret126[t] - b.ret126[t]);
      const n = list.length;
      list.forEach((x, k) => { x.rs[t] = n > 1 ? Math.round((k / (n - 1)) * 100) : 50; });
    }
    D.spx50 = sma(D.spx, 50); D.spx200 = sma(D.spx, 200);
    D.spxVol = new Float64Array(T).fill(NaN); D.spxVolL = new Float64Array(T).fill(NaN);
    const lr = new Float64Array(T).fill(NaN);
    for (let t = 1; t < T; t++) lr[t] = Math.log(D.spx[t] / D.spx[t - 1]);
    const sd = (a, b) => { let s = 0, s2 = 0, k = 0; for (let j = a; j <= b; j++) if (isNum(lr[j])) { s += lr[j]; s2 += lr[j] * lr[j]; k++; } return k > 5 ? Math.sqrt(Math.max(0, s2 / k - (s / k) ** 2)) : NaN; };
    for (let t = 21; t < T; t++) D.spxVol[t] = sd(t - 19, t);
    for (let t = 253; t < T; t++) D.spxVolL[t] = sd(t - 251, t);
  }

  function regimeOk(D, t, level) {
    const s = D.spx[t];
    if (level <= 0) return true;
    if (!(s > D.spx200[t])) return false;
    if (level >= 2 && !(s > D.spx50[t])) return false;
    if (level >= 3 && !(D.spxVol[t] < 1.25 * D.spxVolL[t])) return false;
    return true;
  }

  function regimeText(D, t) {
    const s = D.spx[t];
    const a200 = s > D.spx200[t], a50 = s > D.spx50[t], calm = D.spxVol[t] < 1.25 * D.spxVolL[t];
    if (a200 && a50 && calm) return { key: 'good', text: '상승 추세 · 안정' };
    if (a200 && a50) return { key: 'good', text: '상승 추세 · 변동 큼' };
    if (a200) return { key: 'warn', text: '200일선 위 · 50일선 아래' };
    return { key: 'bad', text: '하락 추세 (200일선 아래)' };
  }

  // ── 2. Simulation ───────────────────────────────────────────────────────────────────────────────────────
  // opts: {from, to, capital, params, adaptive, scores, label}
  function simulate(D, opts) {
    const T = D.dates.length;
    const from = Math.max(opts.from, 210), to = Math.min(opts.to, T - 1);
    const P = Object.assign({}, DEFAULTS, opts.params || {});
    const adaptive = !!opts.adaptive;
    const capital = opts.capital;
    let cash = capital, peak = capital, idSeq = 0;
    const positions = [], trades = [], equity = [], changes = [], reviews = [], signals = [];
    const cool = new Map();                         // symbol index → first day it may be bought again
    const scores = Object.assign({ bo: 0, pb: 0 }, opts.scores || {});
    let share = shareOf(scores), loggedShare = share;
    let streak = 0, blockUntil = -1, ddStopOn = false, lastMarketLoss = -1e9, lastValidate = from, prevEq = capital;
    let riskState = { mult: 1, why: [], blocked: [] }, lastRiskKey = '1|0';
    const ev = Object.assign({ fake: [], pb: [], gap: [], mkt: [], noise_bo: [], noise_pb: [] }, opts.evidence ? JSON.parse(JSON.stringify(opts.evidence)) : {});
    ev.mkt = [];                                    // day indexes do not carry over between runs
    const push = (arr, v, n) => { arr.push(v); while (arr.length > n) arr.shift(); };
    const count = (arr) => arr.filter(Boolean).length;
    const rate = (arr) => (arr.length ? count(arr) / arr.length : 0);
    const D_ = D;

    function log(t, kind, title, body, chg, extra) {
      if (!opts.log) return;
      changes.push(Object.assign({ date: D_.dates[t], t, kind, title, body, changes: chg || [] }, extra || {}));
    }
    function setParam(key, val, list) {
      const [lo, hi] = BOUNDS[key];
      const v = key === 'maxPosW' ? round(clamp(val, lo, hi), 3) : key === 'boLookback' || key === 'regimeLevel' || key === 'rsMin' || key === 'pbRsMin' || key === 'pbRsi' ? Math.round(clamp(val, lo, hi)) : round(clamp(val, lo, hi), 2);
      if (v !== P[key]) { list.push({ key, label: LABELS[key], from: P[key], to: v }); P[key] = v; }
    }
    function toward(key, step, list) {      // move one step back toward the starting value, never past it
      const d = DEFAULTS[key], v = P[key];
      if (v === d) return;
      setParam(key, v > d ? Math.max(d, v - step) : Math.min(d, v + step), list);
    }
    function price(x, t) { return isNum(x.c[t]) ? x.c[t] : x.f[t]; }
    function marked(t) {
      let v = cash;
      for (const p of positions) v += p.qty * price(D.S[p.i], t);
      return v;
    }
    function closeTrade(p, t, px, reason) {
      const x = D.S[p.i];
      const fill = px * (1 - FIXED.slip);
      cash += p.qty * fill;
      const R = (fill - p.fill) / p.R1;
      const tr = {
        id: p.id, sym: x.s, name: x.n, sec: x.sec, pb: p.pb, entryDate: D.dates[p.t0], exitDate: D.dates[t],
        entry: round(p.fill, 2), exit: round(fill, 2), qty: p.qty, stop0: round(p.stop0, 2),
        pnl: round(p.qty * (fill - p.fill), 2), pct: round(fill / p.fill - 1, 4), R: round(R, 2), days: t - p.t0,
        reason, mfeR: round(p.mfeR, 2), idx: round(D.spx[t] / D.spx[p.t0] - 1, 4),
      };
      trades.push(tr);
      positions.splice(positions.indexOf(p), 1);
      return tr;
    }

    for (let t = from; t <= to; t++) {
      const regimeNow = regimeOk(D, t, 1);
      const prov = !!(D.prov && D.prov.t === t);     // market still open: today's prices are not final yet
      const closedToday = [];
      // ── intraday stops: prices sampled during the session; a stop acts at the first sample at or below it
      const samples = D.intra && D.intra[t];
      if (samples && samples.length) {
        for (const sm of samples) {
          for (const p of positions.slice()) {
            if (p.t0 >= t) continue;
            const v = sm.px[D.S[p.i].s];
            if (!isNum(v) || v <= 0 || v > p.stop) continue;
            const kind = p.stop > p.stop0 + 1e-9 ? (v >= p.fill ? '추적 손절(이익 보호)' : '추적 손절') : '손절';
            closedToday.push(closeTrade(p, t, v, `${kind}, 장중 ${sm.t}`));
          }
        }
      }
      // ── exits at today's close (they wait while the market is open)
      if (!prov) for (const p of positions.slice()) {
        const x = D.S[p.i];
        if (!isNum(x.c[t])) {
          p.miss++;
          if (p.miss >= 3) closedToday.push(closeTrade(p, t, price(x, t), '시세 끊김(인수·상장폐지 추정)'));
          continue;
        }
        p.miss = 0;
        const px = x.c[t];
        p.maxC = Math.max(p.maxC, px);
        p.mfeR = Math.max(p.mfeR, (px - p.fill) / p.R1);
        let reason = null;
        if (px <= p.stop) reason = p.stop > p.stop0 + 1e-9 ? (px >= p.fill ? '추적 손절(이익 보호)' : '추적 손절') : '손절';
        else if (p.pb === 'pb' && px > x.sma5[t] && t > p.t0) reason = '반등 청산';
        else if (p.pb === 'pb' && t - p.t0 >= FIXED.timeStop_pb) reason = '시간 청산';
        else if (p.pb === 'bo' && t - p.t0 >= FIXED.timeStop_bo && p.mfeR < 0.5) reason = '시간 손절';
        if (reason) { closedToday.push(closeTrade(p, t, px, reason)); continue; }
        if (p.pb === 'bo') {   // trailing stop moves up only
          const k = regimeNow ? P.trailK : Math.min(P.trailK, 2.0);
          p.stop = Math.max(p.stop, p.maxC - k * p.atr);
        }
      }

      // ── learn from today's closed trades
      // Every loss is diagnosed and counted as evidence. A rule changes when the same cause keeps repeating in the
      // recent trades (one loss is often just luck); protective risk cuts (losing streak, drawdown) act at once.
      for (const tr of closedToday) {
        const pbKey = tr.pb;
        scores[pbKey] = scores[pbKey] * 0.85 + clamp(tr.R, -3, 5) * 0.15;
        streak = tr.R < 0 ? streak + 1 : 0;
        if (!adaptive) continue;
        const isFake = tr.pb === 'bo' && tr.R < 0 && tr.reason.startsWith('손절') && tr.days <= 7 && tr.mfeR < 0.5;
        const isGap = tr.R <= -1.5;
        const isMkt = tr.R <= -0.8 && tr.idx <= -0.03;
        if (tr.pb === 'bo') push(ev.fake, isFake, 12); else push(ev.pb, tr.R < 0, 12);
        push(ev.gap, isGap, 20);
        if (isMkt) ev.mkt.push(t);
        const diag = [], chg = [], evid = [];
        if (tr.R < 0) {
          const si = D.S.findIndex((x) => x.s === tr.sym);
          if (isMkt) diag.push(`보유 기간에 S&P 500이 ${(tr.idx * 100).toFixed(1)}% 빠졌습니다. 시장 전체에 끌려 내려간 손실입니다.`);
          if (isGap) diag.push(`손절선보다 훨씬 아래에서 끝났습니다(${tr.R}R). 하루 사이에 크게 빠진 경우라 이 종목은 ${FIXED.cooldownGap}거래일 쉽니다.`);
          if (isFake) diag.push(`돌파 후 ${tr.days}거래일 만에 손절됐고 +0.5R에 한 번도 닿지 못한 가짜 돌파입니다.`);
          if (tr.pb === 'pb') diag.push('눌림목에서 샀지만 반등하지 못했습니다.');
          if (tr.reason.startsWith('시간') && !diag.length) diag.push('기한 안에 오르지 못해 작은 손실로 정리했습니다.');
          if (!diag.length) diag.push(`손실 ${tr.R}R은 손절 계획 안에서 끝난 보통 손실입니다.`);
          cool.set(si, Math.max(cool.get(si) || 0, t + (isGap ? FIXED.cooldownGap : FIXED.cooldown)));
          if (tr.reason.indexOf('손절') >= 0) reviews.push({ due: t + FIXED.reviewDays, tr, i: si });
        }
        // evidence checks (tighten when a cause repeats, relax when it has gone away)
        const fk = rate(ev.fake), pbl = rate(ev.pb), gp = count(ev.gap);
        if (tr.pb === 'bo' && ev.fake.length >= 8) {
          evid.push(`가짜 돌파 비율은 최근 돌파 매매 ${ev.fake.length}건 중 ${count(ev.fake)}건(${Math.round(fk * 100)}%)입니다.`);
          if (fk >= 0.5) { setParam('boLookback', P.boLookback + 10, chg); setParam('rsMin', P.rsMin + 5, chg); ev.fake = []; evid.push('50% 이상이라 돌파 조건을 조입니다.'); }
          else if (fk <= 0.2 && (P.boLookback > DEFAULTS.boLookback || P.rsMin > DEFAULTS.rsMin)) { toward('boLookback', 10, chg); toward('rsMin', 5, chg); ev.fake = []; evid.push('20% 이하로 줄어 조였던 돌파 조건을 한 단계 풉니다.'); }
        }
        if (tr.pb === 'pb' && ev.pb.length >= 8) {
          evid.push(`눌림목 손실 비율은 최근 ${ev.pb.length}건 중 ${count(ev.pb)}건(${Math.round(pbl * 100)}%)입니다.`);
          if (pbl >= 0.6) { setParam('pbRsi', P.pbRsi - 2, chg); setParam('pbRsMin', P.pbRsMin + 3, chg); ev.pb = []; evid.push('60%를 넘어 더 깊게 눌린 강한 종목만 사도록 바꿉니다.'); }
          else if (pbl <= 0.35 && (P.pbRsi < DEFAULTS.pbRsi || P.pbRsMin > DEFAULTS.pbRsMin)) { toward('pbRsi', 2, chg); toward('pbRsMin', 3, chg); ev.pb = []; evid.push('35% 이하로 줄어 눌림목 조건을 한 단계 풉니다.'); }
        }
        if (isGap || (ev.gap.length >= 20 && gp === 0 && P.maxPosW < DEFAULTS.maxPosW)) {
          evid.push(`−1.5R보다 크게 잃은 매매는 최근 ${ev.gap.length}건 중 ${gp}건입니다.`);
          if (gp >= 3) { setParam('maxPosW', P.maxPosW - 0.02, chg); ev.gap = []; evid.push('3건 이상이라 종목당 최대 비중을 낮춥니다.'); }
          else if (gp === 0) { toward('maxPosW', 0.02, chg); ev.gap = []; evid.push('20건 동안 없어 종목당 최대 비중을 한 단계 되돌립니다.'); }
        }
        ev.mkt = ev.mkt.filter((x) => t - x <= 20);
        if (isMkt) {
          evid.push(`시장 하락 때문에 생긴 손실은 최근 20거래일 동안 ${ev.mkt.length}건입니다.`);
          if (ev.mkt.length >= 2) { setParam('regimeLevel', P.regimeLevel + 1, chg); ev.mkt = []; lastMarketLoss = t; evid.push('2건 이상이라 시장 필터를 한 단계 올립니다.'); }
          else lastMarketLoss = t;
        }
        if (tr.R < 0) {
          const tail = chg.length ? '' : (evid.length ? ' 아직 기준에 못 미쳐 규칙은 그대로 둡니다.' : ' 규칙은 그대로 둡니다.');
          log(t, 'loss', `${tr.sym} 손실 복기`, diag.join(' ') + (evid.length ? ' ' + evid.join(' ') : '') + tail, chg, { trade: tr });
        } else if (chg.length) {
          log(t, 'relax', `${tr.sym} ${tr.R >= 0 ? '+' : ''}${tr.R}R로 마감 · 조건 완화`, evid.join(' '), chg, { trade: tr });
        }
      }
      if (adaptive && !prov) {
        // follow-up 10 days after a stop-out: did the price come back above the entry (stop too tight)?
        for (const rv of reviews.filter((r) => r.due === t)) {
          const x = D.S[rv.i], tr = rv.tr, t1 = D.dates.indexOf(tr.exitDate);
          let hi = -Infinity, lo = Infinity;
          for (let j = t1 + 1; j <= t; j++) if (isNum(x.c[j])) { hi = Math.max(hi, x.c[j]); lo = Math.min(lo, x.c[j]); }
          if (!isFinite(hi)) continue;
          const key = tr.pb === 'bo' ? 'stopK_bo' : 'stopK_pb', w = tr.pb === 'bo' ? ev.noise_bo : ev.noise_pb, chg = [];
          const noise = hi >= tr.entry, right = lo <= tr.exit - (tr.entry - tr.stop0);
          push(w, noise, 10);
          const nr = rate(w);
          let body = noise ? `손절한 뒤 ${FIXED.reviewDays}거래일 안에 다시 매수가(${tr.entry}) 위로 올라왔습니다(최고 ${round(hi, 2)}). 흔들기에 털린 손절입니다.`
            : right ? `손절한 뒤 1R 넘게 더 빠졌습니다(최저 ${round(lo, 2)}). 손절이 제 역할을 했습니다.` : '손절 뒤 크게 오르지도 더 빠지지도 않았습니다.';
          body += ` 털린 손절은 최근 ${w.length}건 중 ${count(w)}건(${Math.round(nr * 100)}%)입니다.`;
          if (w.length >= 6 && nr >= 0.5) { setParam(key, P[key] + 0.25, chg); w.length = 0; body += ' 50% 이상이라 손절 폭을 넓힙니다. 넓힌 만큼 수량을 줄여 1회 위험은 같습니다.'; }
          else if (w.length >= 6 && nr <= 0.2 && P[key] > DEFAULTS[key]) { toward(key, 0.25, chg); w.length = 0; body += ' 20% 이하로 줄어 넓혀 둔 손절 폭을 한 단계 되돌립니다.'; }
          if (noise || right || chg.length) log(t, 'review', `${tr.sym} 손절 ${FIXED.reviewDays}일 뒤 점검`, body, chg, { trade: tr });
        }
        // market filter relaxes after 40 calm days
        if (P.regimeLevel > DEFAULTS.regimeLevel && t - lastMarketLoss >= 40 && D.spx[t] > D.spx50[t]) {
          const chg = []; setParam('regimeLevel', P.regimeLevel - 1, chg); lastMarketLoss = t;
          log(t, 'relax', '시장 필터 완화', '시장 때문에 생긴 손실 없이 40거래일이 지났고 S&P 500이 50일선 위에 있어 시장 필터를 한 단계 낮춥니다.', chg);
        }
        // risk budget between the two playbooks follows their recent results
        share = shareOf(scores);
        if (Math.abs(share - loggedShare) >= 0.1) {
          log(t, 'budget', '전략별 위험 배분 조정', `최근 성과(평균 R, 최근 매매에 더 큰 가중): 돌파 ${round(scores.bo, 2)} · 눌림목 ${round(scores.pb, 2)}. 위험 예산을 돌파 ${Math.round(share * 100)}% · 눌림목 ${Math.round((1 - share) * 100)}%로 나눕니다.`, [{ key: 'share', label: '돌파 매매 위험 배분', from: Math.round(loggedShare * 100) + '%', to: Math.round(share * 100) + '%' }]);
          loggedShare = share;
        }
        // guard against over-fitting: every 20 days compare the adapted rules with the starting rules
        if (t - lastValidate >= FIXED.validateEvery && t - from >= FIXED.validateWindow && differs(P)) {
          lastValidate = t;
          const a = simulate(D, { from: t - FIXED.validateWindow + 1, to: t, capital: 100000, params: P, adaptive: false });
          const b = simulate(D, { from: t - FIXED.validateWindow + 1, to: t, capital: 100000, params: DEFAULTS, adaptive: false });
          const ra = a.stats.ret, rb = b.stats.ret;
          if (ra < rb - FIXED.validateMargin) {
            const chg = [];
            for (const k in DEFAULTS) setParam(k, DEFAULTS[k], chg);
            log(t, 'rollback', '정기 점검: 바꾼 규칙 되돌림', `최근 ${FIXED.validateWindow}거래일을 두 규칙으로 다시 돌려 보니 지금 규칙 ${pctTxt(ra)}, 처음 규칙 ${pctTxt(rb)}였습니다. 고친 규칙이 오히려 나빠 처음 규칙으로 되돌립니다.`, chg);
          } else {
            log(t, 'check', '정기 점검: 유지', `최근 ${FIXED.validateWindow}거래일 재검증 결과 지금 규칙 ${pctTxt(ra)}, 처음 규칙 ${pctTxt(rb)}입니다. 고친 규칙을 유지합니다.`, []);
          }
        } else if (t - lastValidate >= FIXED.validateEvery) lastValidate = t;
      }

      // ── risk state
      const eqNow = marked(t);
      peak = Math.max(peak, eqNow);
      const dd = 1 - eqNow / peak;
      const dayChg = eqNow / prevEq - 1;
      if (dayChg <= -FIXED.dailyLossStop) blockUntil = t + 1;
      if (dd >= FIXED.ddStop) ddStopOn = true;
      if (ddStopOn && dd < FIXED.ddResume) ddStopOn = false;
      let mult = 1; const why = [];
      if (dd >= FIXED.ddHalf) { mult *= 0.5; why.push(`낙폭 ${(dd * 100).toFixed(1)}%: 위험 절반`); }
      if (streak >= 5) { mult *= 0.25; why.push(`${streak}연패: 위험 1/4`); } else if (streak >= 3) { mult *= 0.5; why.push(`${streak}연패: 위험 절반`); }
      const blocked = [];
      if (ddStopOn) blocked.push(`낙폭 ${(dd * 100).toFixed(1)}%: 10% 안으로 회복할 때까지 신규 매수 중지`);
      if (blockUntil >= t) blocked.push(`하루 손실 ${(FIXED.dailyLossStop * 100).toFixed(1)}% 이상: 다음 거래일까지 신규 매수 중지`);
      riskState = { mult, why, blocked, dd, streak };
      const rKey = mult + '|' + blocked.length;
      if (rKey !== lastRiskKey) {
        if (adaptive) log(t, 'risk', mult < 1 || blocked.length ? '리스크 브레이크 작동' : '리스크 브레이크 해제', (why.concat(blocked).join(' · ')) || '연패와 낙폭이 기준 안으로 돌아와 1회 위험을 원래대로 씁니다.', []);
        lastRiskKey = rKey;
      }

      // ── entries at today's close
      const todaySignals = [];
      if (!blocked.length && regimeOk(D, t, P.regimeLevel)) {
        const held = new Set(positions.map((p) => p.i));
        const cands = [];
        for (let i = 0; i < D.S.length; i++) {
          const x = D.S[i];
          if (!x.e[t] || held.has(i) || (cool.get(i) || 0) > t) continue;
          const c = x.c[t];
          if (!isNum(c) || !isNum(x.sma200[t]) || !isNum(x.vol[t]) || x.vol[t] <= 0) continue;
          const trend = c > x.sma50[t] && x.sma50[t] > x.sma200[t];
          if (trend && x.dom[t] >= P.boLookback && x.rs[t] >= P.rsMin) cands.push({ i, pb: 'bo', score: x.rs[t] + 0.5 });
          else if (c > x.sma200[t] && x.sma50[t] > x.sma200[t] && x.rs[t] >= P.pbRsMin && x.rsi2[t] < P.pbRsi) cands.push({ i, pb: 'pb', score: x.rs[t] });
        }
        cands.sort((a, b) => b.score - a.score);
        let opened = 0;
        const eq = eqNow;
        let heat = positions.reduce((s, p) => s + Math.max(0, (p.fill - p.stop)) * p.qty, 0);
        for (const cd of cands) {
          const x = D.S[cd.i], c = x.c[t];
          const sig = { sym: x.s, name: x.n, pb: cd.pb, rs: x.rs[t], price: round(c, 2), taken: false, why: '' };
          todaySignals.push(sig);
          if (prov) { sig.why = '장 마감 무렵 다시 판단'; continue; }
          if (opened >= FIXED.maxNewPerDay) { sig.why = `하루 신규 ${FIXED.maxNewPerDay}종목 한도`; continue; }
          if (positions.length >= FIXED.maxPositions) { sig.why = `보유 ${FIXED.maxPositions}종목 한도`; continue; }
          if (positions.filter((p) => D.S[p.i].sec === x.sec).length >= FIXED.sectorMax) { sig.why = `같은 업종 ${FIXED.sectorMax}종목 한도`; continue; }
          const atr = x.vol[t] * c;
          const fill = c * (1 + FIXED.slip);
          const k = cd.pb === 'bo' ? P.stopK_bo : P.stopK_pb;
          const stop = fill - k * atr;
          const perShare = fill - stop;
          const pbShare = cd.pb === 'bo' ? share : 1 - share;
          const risk = eq * FIXED.riskPct * mult * 2 * pbShare;
          let qty = Math.floor(risk / perShare);
          qty = Math.min(qty, Math.floor((P.maxPosW * eq) / fill), Math.floor(cash / fill));
          if (heat + qty * perShare > FIXED.heatMax * eq) qty = Math.floor(Math.max(0, FIXED.heatMax * eq - heat) / perShare);
          if (qty < 1 || qty * fill < FIXED.minValue * eq) { sig.why = cash < fill ? '현금 부족' : '위험 한도(열린 위험 6%) 소진'; continue; }
          cash -= qty * fill;
          heat += qty * perShare;
          positions.push({ id: ++idSeq, i: cd.i, pb: cd.pb, t0: t, fill, qty, stop, stop0: stop, R1: perShare, atr, maxC: c, mfeR: 0, miss: 0 });
          sig.taken = true; sig.qty = qty; sig.stop = round(stop, 2);
          opened++;
        }
      }
      if (t === to) signals.push(...todaySignals);

      const eqEnd = marked(t);
      const ep = { date: D.dates[t], eq: round(eqEnd, 2), cash: round(cash, 2), n: positions.length, dd: round(1 - eqEnd / Math.max(peak, eqEnd), 4), bench: round(capital * D.spx[t] / D.spx[from], 2) };
      if (D.times && D.times[t]) ep.time = D.times[t];
      if (prov) ep.prov = true;
      equity.push(ep);
      prevEq = eqEnd;
    }

    const lastT = Math.min(to, T - 1);
    const open = positions.map((p) => {
      const x = D.S[p.i], px = price(x, lastT);
      return { id: p.id, sym: x.s, name: x.n, sec: x.sec, pb: p.pb, entryDate: D.dates[p.t0], entry: round(p.fill, 2), qty: p.qty, price: round(px, 2),
        value: round(px * p.qty, 2), pnl: round((px - p.fill) * p.qty, 2), pct: round(px / p.fill - 1, 4), stop: round(p.stop, 2), stop0: round(p.stop0, 2),
        R: round((px - p.fill) / p.R1, 2), days: lastT - p.t0, riskToStop: round(Math.max(0, px - p.stop) * p.qty, 2) };
    });
    return { from, to: lastT, capital, equity, trades, open, changes, params: P, scores, share, evidence: ev, risk: riskState, signals, stats: stats(equity, trades, capital), prov: !!(D.prov && D.prov.t === lastT) };
  }

  function shareOf(sc) { return round(clamp(0.5 + 0.25 * (sc.bo - sc.pb), 0.25, 0.75), 2); }
  function differs(P) { for (const k in DEFAULTS) if (P[k] !== DEFAULTS[k]) return true; return false; }
  function pctTxt(v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }

  function stats(equity, trades, capital) {
    if (!equity.length) return { ret: 0, bench: 0, mdd: 0, n: 0 };
    const last = equity[equity.length - 1];
    let peak = -Infinity, mdd = 0, bpeak = -Infinity, bmdd = 0;
    for (const e of equity) { peak = Math.max(peak, e.eq); mdd = Math.max(mdd, 1 - e.eq / peak); bpeak = Math.max(bpeak, e.bench); bmdd = Math.max(bmdd, 1 - e.bench / bpeak); }
    const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
    const years = equity.length / 252;
    return {
      ret: last.eq / capital - 1, bench: last.bench / capital - 1, mdd, bmdd, n: trades.length, win: trades.length ? wins.length / trades.length : 0,
      avgR: trades.length ? trades.reduce((s, t) => s + t.R, 0) / trades.length : 0, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      cagr: years >= 1 ? Math.pow(last.eq / capital, 1 / years) - 1 : null, bcagr: years >= 1 ? Math.pow(last.bench / capital, 1 / years) - 1 : null,
      days: equity.length, avgDays: trades.length ? trades.reduce((s, t) => s + t.days, 0) / trades.length : 0,
      exposure: equity.reduce((s, e) => s + (1 - e.cash / e.eq), 0) / equity.length,
    };
  }

  // ── 3. Whole app run: past test, then the live paper account that starts from what the test learned ─────
  function runAll(seed, live, settings, intra) {
    const D = prepare(seed, live, intra);
    const T = D.dates.length;
    const capital = (settings && settings.capital) || 100000;
    const liveStart = (settings && settings.liveStart) || '2026-11-17';
    const btStart = (settings && settings.btStart) || '2025-01-02';
    const bi = D.dates.findIndex((d) => d >= btStart);
    let li = D.dates.findIndex((d) => d >= liveStart);
    const liveReady = li >= 0;
    if (!liveReady) li = T;
    const bt = simulate(D, { from: bi, to: li - 1, capital, params: DEFAULTS, adaptive: true, log: true });
    const warm = Object.assign({}, bt.params);
    let lv = null;
    if (liveReady) {
      lv = simulate(D, { from: li, to: T - 1, capital, params: warm, scores: bt.scores, evidence: bt.evidence, adaptive: true, log: true });
      lv.changes.unshift({ date: D.dates[li], t: li, kind: 'start', title: '연습 계좌 시작', body: `시작 자금 $${capital.toLocaleString('en-US')}. 과거 검증(${D.dates[bi]}~${D.dates[li - 1]}) 동안 스스로 고친 규칙에서 출발합니다.`, changes: Object.keys(DEFAULTS).filter((k) => warm[k] !== DEFAULTS[k]).map((k) => ({ key: k, label: LABELS[k], from: DEFAULTS[k], to: warm[k] })) });
    }
    return {
      D: { dates: D.dates, last: D.dates[T - 1], lastTime: D.times[T - 1] || null, prov: D.prov ? { date: D.dates[D.prov.t], time: D.prov.time } : null, liveDays: D.liveDays, notes: D.notes, symbols: D.S.length },
      regime: regimeText(D, T - 1), spxLast: D.spx[T - 1],
      gate: { ok: regimeOk(D, T - 1, (lv ? lv.params : warm).regimeLevel), level: (lv ? lv.params : warm).regimeLevel, spx: round(D.spx[T - 1], 2), spx50: round(D.spx50[T - 1], 2), spx200: round(D.spx200[T - 1], 2) },
      bt, live: lv, warm, liveStart, liveStartIdx: li, capital,
    };
  }

  const api = { DEFAULTS, BOUNDS, LABELS, UNITS, FIXED, PB_NAME, prepare, simulate, runAll, regimeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperEngine = api;
})(typeof self !== 'undefined' ? self : this);
