/* 자동매매 연습장 엔진 v3
   Paper-trading engine with risk management and a self-correction module.
   Pure functions over daily closes plus intraday price samples: the same input always gives the same trades, so the
   whole account can be rebuilt from the price files at any time. v2 adds intraday stop checks (prices sampled about
   every 15 minutes during the session) and a provisional "today" while the market is open: stops act at once, a loss
   is reviewed as soon as it happens, and new buys wait for the closing prices. v3 lets the holding period follow the
   results: a day-trading playbook bought and sold within the session, wider trailing stops for big winners, and
   waiting periods that lengthen or shorten after each exit is reviewed. v4 keeps the live account as a book: a day
   whose closing prices are final is saved with everything the account holds and has learned, and later runs continue
   from there, so fills that happened never change; the evolution lab (evolve.js) may change the rules from the next
   day on. Runs in node and in the browser. */
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
    timeStop_bo: 25,    // breakout: sell if it has not reached +0.5R after this many trading days
    timeStop_pb: 8,     // pullback: longest holding
    holdK: 1.0,         // breakout trades that reached +3R: trailing stop this much wider, to ride the trend longer
    dtStopK: 0.6,       // day trade: stop = entry − k × daily price swing
    dtMinUp: 1.0,       // day trade: up at least this % on the day
    dtRsMin: 70,        // day trade: 6-month return rank
    hedgeK: 0.5,        // hedge: inverse S&P 500 worth this share of the stocks held overnight when the S&P 500 is below its 200-day average
    stopK_bd: 3.0,      // bonds: stop = entry − k × daily price swing, trailing from the highest close
    lev: 1.0,           // leverage: buying power up to this many times the account value (margin interest on what is borrowed)
  };
  const BOUNDS = {
    stopK_bo: [1.5, 3.5], stopK_pb: [1.5, 3.5], trailK: [2.0, 4.5], boLookback: [20, 120], rsMin: [50, 90],
    pbRsMin: [60, 95], pbRsi: [3, 20], regimeLevel: [0, 3], maxPosW: [0.08, 0.20],
    timeStop_bo: [10, 60], timeStop_pb: [4, 20], holdK: [0, 3], dtStopK: [0.4, 1.5], dtMinUp: [0.5, 3], dtRsMin: [50, 90], hedgeK: [0, 1], stopK_bd: [2, 5], lev: [1, 2],
  };
  const LABELS = {
    stopK_bo: '돌파 매매 손절 폭', stopK_pb: '눌림목 매매 손절 폭', trailK: '추적 손절 폭',
    boLookback: '돌파 기준 기간', rsMin: '돌파 매매 최소 상대강도', pbRsMin: '눌림목 매매 최소 상대강도',
    pbRsi: '눌림목 과매도 기준', regimeLevel: '시장 필터 단계', maxPosW: '종목당 최대 비중',
    timeStop_bo: '돌파 매매 기다리는 기간', timeStop_pb: '눌림목 매매 최대 보유', holdK: '크게 오른 종목 추가 추적 폭',
    dtStopK: '단타 손절 폭', dtMinUp: '단타 최소 당일 상승률', dtRsMin: '단타 최소 상대강도', hedgeK: '하락장 헷지 비율', stopK_bd: '채권 손절 폭', lev: '최대 레버리지',
  };
  const UNITS = {
    stopK_bo: '변동폭 ×', stopK_pb: '변동폭 ×', trailK: '변동폭 ×', boLookback: '거래일', rsMin: '백분위',
    pbRsMin: '백분위', pbRsi: 'RSI(2) 미만', regimeLevel: '단계', maxPosW: '%',
    timeStop_bo: '거래일', timeStop_pb: '거래일', holdK: '변동폭 ×', dtStopK: '하루 변동폭 ×', dtMinUp: '%', dtRsMin: '백분위', hedgeK: '× 보유 주식', stopK_bd: '변동폭 ×', lev: '× 계좌 금액',
  };
  // Fixed risk rules (never changed by the system)
  const FIXED = {
    riskPct: 0.0075, maxPositions: 10, heatMax: 0.06, sectorMax: 3, maxNewPerDay: 3,
    slip: 0.001, holdFromR: 3,
    // day trades: entries between 10:00 and 14:30 New York time on a new high of the day, half the usual risk,
    // at most 3 open and 4 new per day, sold at +2R, at the stop, or at the close at the latest
    dtFrom: '10:00', dtUntil: '14:30', dtRiskMult: 0.5, dtMax: 3, dtNewPerDay: 4, dtTargetR: 2, dtMaxUp: 0.08,
    dtRel: 0.01, dtMktMin: -0.003, dtCooldown: 3, dtPauseScore: -0.3, dtPauseMin: 8, dtPauseDays: 10,
    // strategy tournament: every 20 trading days each playbook runs alone over the last 120 trading days
    // hedge: an inverse S&P 500 position (like ProShares SH, −1× the daily move, 0.89% a year in fund costs), set at the
    // close; it moves only when the target differs by more than $1,000 and 20%
    hedgeExp: 0.0089, hedgeMin: 1000, hedgeBand: 0.2,
    selectEvery: 20, selectWindow: 120, selectMinTrades: 5, selectTrialM: 0.25, selectTiers: [1, 0.5, 0.17], selectLoserM: 0.17,
    // bonds: at most 4 at a time, bought at the close while the bond's total-return index is above its 100-day average
    // and up over 63 trading days (ranked by that return over its volatility)
    bdMax: 4,
    // margin (Robinhood, checked 2026-11-18): yearly rate by amount borrowed, on the whole balance, charged per calendar
    // day at rate / 360; under $1 borrowed is rounding and costs nothing
    marginRates: [[50000, 0.05], [100000, 0.048], [1e9, 0.045]], marginMin: 1,
    dailyLossStop: 0.025, ddHalf: 0.08, ddStop: 0.15, ddResume: 0.10,
    cooldown: 10, cooldownGap: 30, reviewDays: 10,
    validateEvery: 20, validateWindow: 120, validateMargin: 0.03, minValue: 0.005,
  };
  const PB_NAME = { bo: '신고가 돌파', pb: '추세 눌림목', dt: '당일 단타', bd: '채권 추세' };
  // the four teams and the rules each one owns
  const TEAMS = { select: '종목선정팀', entry: '매수팀', exit: '매도팀', risk: '리스크·헷지팀' };
  const TEAM_OF = { rsMin: 'select', pbRsMin: 'select', dtRsMin: 'select', boLookback: 'select', pbRsi: 'entry', dtMinUp: 'entry',
    stopK_bo: 'exit', stopK_pb: 'exit', trailK: 'exit', holdK: 'exit', timeStop_bo: 'exit', timeStop_pb: 'exit', dtStopK: 'exit',
    regimeLevel: 'risk', maxPosW: 'risk', hedgeK: 'risk', stopK_bd: 'exit', lev: 'risk' };
  function teamsOf(kind, chg) {
    const ts = [...new Set((chg || []).map((g) => TEAM_OF[g.key] || (/^m_/.test(g.key) ? 'risk' : null)).filter(Boolean))];
    if (ts.length) return ts;
    return [{ loss: 'exit', review: 'exit', budget: 'risk', risk: 'risk', rollback: 'risk', check: 'risk', hedge: 'risk', pick: 'select', relax: 'select', start: 'risk' }[kind] || 'risk'];
  }

  const SPLITS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 10, 1 / 12, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50, 2 / 3, 3 / 2];
  const nearestSplit = (v) => SPLITS.reduce((b, c) => (Math.abs(v / c - 1) < Math.abs(v / b - 1) ? c : b), SPLITS[0]);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v, d) => { const m = Math.pow(10, d); return Math.round(v * m) / m; };
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  // ── 1. Data: merge the static history with the daily snapshots collected since ─────────────────────────
  // seed: {dates, spx, syms:[{s,n,sec,c,e}], excl?};  live: {meta:{SYM:[name, sector]}, days:[{date, spx, rows:{SYM:[close, pct, capB]}}]}
  const companyKey = (n) => String(n || '').toLowerCase().replace(/\b(class [a-c]|common stock|ordinary shares?|inc\.?|corp(oration)?\.?|ltd\.?|plc|n\.?v\.?|s\.?a\.?|holdings?|co\.?|the)\b/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  // intra: {DATE: {syms: [...], snaps: [{t: 'HH:MM', spx, p: [prices in syms order]}]}} raw prices sampled during the
  // session (also accepts the older [{t, px: {SYM: price}}] form)
  function prepare(seed, live, intra, extra) {
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
    // other instruments (bonds) on the same days: after the stocks, and outside every stock rule (eligible = 0)
    const bond0 = S.length;
    if (extra && typeof extra.instruments === 'function') {
      for (const ins of extra.instruments(dates) || []) {
        if (!ins || !ins.s || bySym.has(ins.s) || !Array.isArray(ins.c) || ins.c.length !== dates.length) continue;
        bySym.set(ins.s, S.length);
        S.push({ s: ins.s, n: ins.n || ins.s, sec: ins.sec || '채권', kind: ins.kind || 'bond', syn: !!ins.syn, ccy: ins.ccy || null,
          c: ins.c.map((v) => (isNum(v) && v > 0 ? v : NaN)), e: new Array(dates.length).fill(0), yld: Array.isArray(ins.y) ? ins.y : null });
      }
    }
    // the last day is provisional while the market is still open (prices from the latest intraday snapshot)
    const lastDay = days[days.length - 1];
    const prov = lastDay && lastDay.src === 'intraday' && !lastDay.final && dates[dates.length - 1] === lastDay.date
      ? { t: dates.length - 1, time: lastDay.t || null } : null;
    // intraday snapshots aligned to day indexes as price arrays by symbol, on the same split-adjusted scale as the closes
    const snap = new Array(dates.length).fill(null);
    const symIdx = new Map(S.map((x, i) => [x.s, i]));
    const blank = () => new Float64Array(S.length).fill(NaN);
    if (intra) {
      for (const dt in intra) {
        const t = dates.indexOf(dt), doc = intra[dt];
        if (t < 0 || !doc) continue;
        let list = [];
        if (Array.isArray(doc)) {
          list = doc.filter((s) => s && s.t && s.px).map((s) => { const a = blank(); for (const k in s.px) { const i = symIdx.get(k); if (i != null && isNum(s.px[k]) && s.px[k] > 0) a[i] = s.px[k]; } return { t: s.t, spx: NaN, px: a }; });
        } else if (Array.isArray(doc.snaps)) {
          const syms = doc.syms || [];
          const map = syms.map((k) => symIdx.get(k));
          list = doc.snaps.filter((s) => s && s.t && Array.isArray(s.p)).map((s) => {
            const a = blank(); s.p.forEach((v, j) => { const i = map[j]; if (i != null && isNum(v) && v > 0) a[i] = v; });
            let hi = null;
            if (Array.isArray(s.h)) { hi = blank(); s.h.forEach((v, j) => { const i = map[j]; if (i != null && isNum(v) && v > 0) hi[i] = v; }); }
            return { t: s.t, spx: isNum(s.spx) ? s.spx : NaN, px: a, hi };
          });
        }
        list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
        if (list.length) snap[t] = list;
      }
      for (const a of splitAdj) { const i = symIdx.get(a.sym); for (let j = 0; j < a.t; j++) if (snap[j]) for (const sm of snap[j]) { if (isNum(sm.px[i])) sm.px[i] *= a.factor; if (sm.hi && isNum(sm.hi[i])) sm.hi[i] *= a.factor; } }
    }
    const D = { dates, spx, S, notes, liveDays: days.length, snap, times, prov, bond0, splits: splitAdj.map((a) => ({ sym: a.sym, t: a.t, date: dates[a.t], factor: a.factor })) };
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
      if (x.kind === 'bond') {         // bonds: a slower trend (100 days) and three-month momentum
        x.sma100 = sma(f, 100);
        x.ret63 = new Float64Array(T).fill(NaN);
        for (let t = 63; t < T; t++) if (isNum(f[t]) && isNum(f[t - 63])) x.ret63[t] = f[t] / f[t - 63] - 1;
      }
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

  // ── the macro picture from data the engine already has: the S&P 500's trend and volatility, US rates (the 2-year
  // yield's change over three months and the 10-year minus 2-year curve) and the median three-month change of 10-year
  // yields across the bond countries. Changes of 0.25%p or more over three months count as a direction.
  const pctS = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%';
  const ppS = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%p';
  function macroAt(D, t) {
    if (!D._mx) {
      const ys = {};
      if (D.bond0 != null) for (let i = D.bond0; i < D.S.length; i++) { const x = D.S[i]; if (x.yld) ys[x.s] = x.yld; }
      D._mx = { us2: ys.US2Y || null, us10: ys.US10Y || null, tens: Object.keys(ys).filter((k) => /10Y$/.test(k)).map((k) => ys[k]) };
    }
    const X = D._mx, s = D.spx[t];
    const at = (arr, k) => { if (!arr || k < 0) return NaN; for (let j = k; j >= 0 && j > k - 6; j--) if (isNum(arr[j])) return arr[j]; return NaN; };
    const y2 = at(X.us2, t), y10 = at(X.us10, t), dy2 = y2 - at(X.us2, t - 63);
    const dTen = X.tens.map((a) => at(a, t) - at(a, t - 63)).filter(isNum).sort((a, b) => a - b);
    const gl = dTen.length >= 5 ? dTen[dTen.length >> 1] : NaN;
    const vol = D.spxVol[t] * Math.sqrt(252), volL = D.spxVolL[t] * Math.sqrt(252);
    const dir = (v) => (!isNum(v) ? null : v <= -0.25 ? 'falling' : v >= 0.25 ? 'rising' : 'flat');
    return { date: D.dates[t], spx: s, d200: s / D.spx200[t] - 1, d50: s / D.spx50[t] - 1,
      trend: !(s > D.spx200[t]) ? 'down' : !(s > D.spx50[t]) ? 'mixed' : 'up',
      vol, volL, volLv: !isNum(vol) || !isNum(volL) ? null : vol > 1.25 * volL ? 'high' : vol < 0.8 * volL ? 'low' : 'normal',
      y2, dy2, rates: dir(dy2), y10, curve: y10 - y2, gl, glDir: dir(gl), glN: dTen.length };
  }
  // one line about the market on a given day, kept with each position as the market it was bought in
  function macroLine(m) {
    const out = [`S&P 500 ${m.trend === 'up' ? '상승 추세' : m.trend === 'mixed' ? '50일선 아래' : '하락 추세'}`];
    if (isNum(m.vol)) out.push(`변동성 ${(m.vol * 100).toFixed(0)}%${isNum(m.volL) ? `(1년 ${(m.volL * 100).toFixed(0)}%)` : ''}`);
    if (isNum(m.y2)) out.push(`미 2년 금리 ${m.y2.toFixed(2)}%${isNum(m.dy2) ? `(3개월 ${ppS(m.dy2)})` : ''}`);
    return out.join(' · ');
  }

  // ── 2. Simulation ───────────────────────────────────────────────────────────────────────────────────────
  // opts: {from, to, capital, params, adaptive, scores, label}
  function simulate(D, opts) {
    const T = D.dates.length;
    // opts.resume: a book ({date, from0, capital, state, hist}). The run starts the day after the book's last day with
    // everything the account held and had learned, and the book's history is carried over as it is.
    const BK = opts.resume || null, BS = BK ? BK.state : null;
    const tc = BK ? D.dates.indexOf(BK.date) : -1;
    if (BK && tc < 0) throw new Error('book day missing from the price data: ' + BK.date);
    const from = BK ? tc + 1 : Math.max(opts.from, 210), to = Math.min(opts.to, T - 1);
    const base0 = BK ? Math.max(0, D.dates.indexOf(BK.from0)) : from;     // the account's first day
    const P = Object.assign({}, DEFAULTS, (BS ? BS.P : opts.params) || {});
    let ctxT = -1, ctxS = '';
    const ctxAt = (k) => { if (k !== ctxT) { ctxT = k; ctxS = macroLine(macroAt(D, k)); } return ctxS; };
    const highTxt = (n) => (n >= 250 ? '1년 넘게 가장 높은 종가(신고가)' : `${n}거래일 신고가`);
    // the rules a correction steps back toward and the regular check compares with: the starting rules, or the rules
    // the evolution lab promoted last
    const B = Object.assign({}, DEFAULTS, (BS ? BS.base : opts.base) || {});
    const adaptive = !!opts.adaptive;
    const capital = BK ? BK.capital : opts.capital;
    let cash = capital, peak = capital, idSeq = 0;
    const positions = [], trades = [], equity = [], changes = [], reviews = [], holdReviews = [], signals = [], intraday = [];
    let hedge = null;                               // inverse S&P 500 position held by the risk & hedge team
    const hedgeFills = [], hedgeEpisodes = [];
    const cool = new Map();                         // symbol index → first day it may be bought again
    const scores = Object.assign({ bo: 0, pb: 0, dt: 0 }, (BS ? BS.scores : opts.scores) || {});
    // share of the normal 1-trade risk each playbook may use, set by the strategy tournament
    let M = Object.assign({ bo: 1, pb: 1, dt: FIXED.selectTrialM, bd: FIXED.selectTrialM }, (BS ? BS.M : opts.mults) || {});
    const riskMul = (k) => M[k];
    const only = opts.only || null;                               // tournament runs: one playbook alone
    let lastSelect = -1e9, dtPausedUntil = -1, dtCount = 0;
    let streak = 0, blockUntil = -1, ddStopOn = false, lastMarketLoss = -1e9, lastValidate = from, prevEq = capital;
    let riskState = { mult: 1, why: [], blocked: [] }, lastRiskKey = '1|0';
    let mInt = 0;                                   // margin interest paid
    const isBond = (i) => D.S[i].kind === 'bond';
    const bpow = (eq) => Math.max(0, cash + (P.lev - 1) * eq);   // buying power: cash, plus margin when leverage is allowed
    const ev0 = BS ? BS.ev : opts.evidence;
    const ev = Object.assign({ fake: [], pb: [], gap: [], mkt: [], noise_bo: [], noise_pb: [], tbo: [], tpb: [], trail: [], hold: [], dtq: [], dtf: [], hedge: [] }, ev0 ? JSON.parse(JSON.stringify(ev0)) : {});
    ev.mkt = BS ? (BS.ev.mkt || []).map((v) => tc + v) : [];      // day indexes carry over only from a book
    let symMap = null;
    const symIdx = (s) => (symMap || (symMap = new Map(D.S.map((x, k) => [x.s, k])))).get(s);
    if (BS) {
      const at = (v) => tc + v;                     // the book keeps days as trading days after its last day
      cash = BS.cash; peak = BS.peak; idSeq = BS.idSeq; prevEq = BS.prevEq;
      lastSelect = at(BS.lastSelect); dtPausedUntil = at(BS.dtPausedUntil); dtCount = BS.dtCount; streak = BS.streak;
      blockUntil = at(BS.blockUntil); ddStopOn = BS.ddStopOn; lastMarketLoss = at(BS.lastMarketLoss); lastValidate = at(BS.lastValidate);
      riskState = JSON.parse(JSON.stringify(BS.riskState)); lastRiskKey = BS.lastRiskKey; mInt = BS.mInt || 0;
      const need = (s) => { const k = symIdx(s); if (k == null) throw new Error('book symbol missing from the price data: ' + s); return k; };
      for (const p of BS.positions) { const q = Object.assign({}, p, { i: need(p.sym), t0: at(p.t0) }); delete q.sym; positions.push(q); }
      for (const r of BS.reviews) reviews.push({ due: at(r.due), tr: r.tr, i: need(r.sym) });
      for (const r of BS.holdReviews) holdReviews.push({ due: at(r.due), tr: r.tr, i: need(r.sym) });
      for (const [s, d] of BS.cool) { const k = symIdx(s); if (k != null) cool.set(k, at(d)); }
      hedge = BS.hedge ? Object.assign({}, BS.hedge, { t0: at(BS.hedge.t0) }) : null;
      // a split found after the book's last day: the saved prices of a held stock move to the new scale, its shares the other way
      for (const sp of D.splits || []) {
        if (sp.t <= tc) continue;
        for (const p of positions) if (D.S[p.i].s === sp.sym) {
          for (const k of ['fill', 'stop', 'stop0', 'R1', 'atr', 'maxC', 'lastPx']) if (isNum(p[k])) p[k] *= sp.factor;
          p.qty = Math.round(p.qty / sp.factor);
        }
        for (const r of reviews.concat(holdReviews)) if (r.tr.sym === sp.sym) r.tr = Object.assign({}, r.tr, { entry: r.tr.entry * sp.factor, exit: r.tr.exit * sp.factor, stop0: r.tr.stop0 * sp.factor });
      }
      const h = BK.hist || {};
      equity.push(...(h.equity || [])); trades.push(...(h.trades || [])); hedgeFills.push(...(h.hedgeFills || [])); hedgeEpisodes.push(...(h.hedgeEpisodes || []));
      if (opts.log) changes.push(...(h.changes || []));
    }
    const push = (arr, v, n) => { arr.push(v); while (arr.length > n) arr.shift(); };
    const count = (arr) => arr.filter(Boolean).length;
    const rate = (arr) => (arr.length ? count(arr) / arr.length : 0);
    const D_ = D;

    function log(t, kind, title, body, chg, extra) {
      if (!opts.log) return;
      changes.push(Object.assign({ date: D_.dates[t], t, kind, title, body, changes: chg || [], teams: teamsOf(kind, chg) }, extra || {}));
    }
    function setParam(key, val, list) {
      const [lo, hi] = BOUNDS[key];
      const v = key === 'maxPosW' ? round(clamp(val, lo, hi), 3) : key === 'boLookback' || key === 'regimeLevel' || key === 'rsMin' || key === 'pbRsMin' || key === 'pbRsi' || key === 'timeStop_bo' || key === 'timeStop_pb' || key === 'dtRsMin' ? Math.round(clamp(val, lo, hi)) : round(clamp(val, lo, hi), 2);
      if (v !== P[key]) { list.push({ key, label: LABELS[key], from: P[key], to: v }); P[key] = v; }
    }
    function toward(key, step, list) {      // move one step back toward the starting value, never past it
      const d = B[key], v = P[key];
      if (v === d) return;
      setParam(key, v > d ? Math.max(d, v - step) : Math.min(d, v + step), list);
    }
    function price(x, t) { return isNum(x.c[t]) ? x.c[t] : x.f[t]; }
    function marked(t) {
      let v = cash;
      for (const p of positions) v += p.qty * price(D.S[p.i], t);
      if (hedge) v += hedge.value;
      return v;
    }
    function closeTrade(p, t, px, reason, tm, k) {
      const x = D.S[p.i];
      const fill = px * (1 - FIXED.slip);
      const fs = x.syn ? { sec: 0, taf: 0, cat: 0, total: 0 } : sellFee(p.qty, fill, D.dates[t]);
      cash += p.qty * fill - fs.total;
      const R = (fill - p.fill) / p.R1;
      const tr = {
        id: p.id, sym: x.s, name: x.n, sec: x.sec, pb: p.pb, entryDate: D.dates[p.t0], exitDate: D.dates[t],
        entry: round(p.fill, 2), exit: round(fill, 2), qty: p.qty, stop0: round(p.stop0, 2),
        pnl: round(p.qty * (fill - p.fill) - fs.total - (p.feeIn || 0), 2), pct: round(fill / p.fill - 1, 4), R: round(R, 2), days: t - p.t0,
        reason, mfeR: round(p.mfeR, 2), idx: round(D.spx[t] / D.spx[p.t0] - 1, 4),
        fee: cent(fs.total + (p.feeIn || 0)), feeBuy: p.feeIn || 0, feeSell: fs,
        et: p.et || null, xt: tm || (D.times && D.times[t]) || null, why: p.why || null, ctx: p.ctx || null,
      };
      if (p.pb === 'dt') { tr.k0 = p.k0; tr.k1 = k == null ? 1e9 : k; }
      trades.push(tr);
      positions.splice(positions.indexOf(p), 1);
      return tr;
    }

    // ── learn from a closed trade
    // Every loss is diagnosed and counted as evidence. A rule changes when the same cause keeps repeating in the
    // recent trades (one loss is often just luck); protective risk cuts (losing streak, drawdown) act at once.
    function learn(tr, t) {
        const pbKey = tr.pb;
        scores[pbKey] = scores[pbKey] * 0.85 + clamp(tr.R, -3, 5) * 0.15;
        streak = tr.R < 0 ? streak + 1 : 0;
        if (!adaptive) return;
        const si = D.S.findIndex((x) => x.s === tr.sym);
        const dtQuick = tr.pb === 'dt' && tr.R < 0 && tr.reason.indexOf('손절') >= 0 && hmMin(tr.xt) - hmMin(tr.et) <= 30;
        const dtFade = tr.pb === 'dt' && tr.R < 0 && tr.reason.indexOf('장 마감') >= 0;
        const isFake = tr.pb === 'bo' && tr.R < 0 && tr.reason.startsWith('손절') && tr.days <= 7 && tr.mfeR < 0.5;
        const isGap = tr.R <= -1.5;
        const isMkt = tr.pb !== 'bd' && tr.R <= -0.8 && tr.idx <= -0.03;
        if (tr.pb === 'bo') push(ev.fake, isFake, 12); else if (tr.pb === 'pb') push(ev.pb, tr.R < 0, 12);
        else { push(ev.dtq, dtQuick, 10); push(ev.dtf, dtFade, 10); }
        push(ev.gap, isGap, 20);
        if (isMkt) ev.mkt.push(t);
        const diag = [], chg = [], evid = [];
        if (tr.R < 0) {
          if (isMkt) diag.push(`보유 기간에 S&P 500이 ${(tr.idx * 100).toFixed(1)}% 빠졌습니다. 시장 전체에 끌려 내려간 손실입니다.`);
          if (isGap) diag.push(tr.pb === 'dt' ? `손절선보다 훨씬 아래에서 팔렸습니다(${tr.R}R). 몇 분 사이에 크게 빠진 경우라 이 종목은 ${FIXED.cooldownGap}거래일 쉽니다.` : `손절선보다 훨씬 아래에서 끝났습니다(${tr.R}R). 하루 사이에 크게 빠진 경우라 이 종목은 ${FIXED.cooldownGap}거래일 쉽니다.`);
          if (isFake) diag.push(`돌파 후 ${tr.days}거래일 만에 손절됐고 +0.5R에 한 번도 닿지 못한 가짜 돌파입니다.`);
          if (tr.pb === 'pb') diag.push('눌림목에서 샀지만 반등하지 못했습니다.');
          if (dtQuick) diag.push('산 뒤 30분 안에 손절됐습니다. 장중 흔들림에 털린 단타입니다.');
          if (dtFade) diag.push('당일 고점을 뚫을 때 샀지만 힘이 빠져 장 마감에 손실로 정리했습니다.');
          if (tr.reason.startsWith('시간') && !diag.length) diag.push('기한 안에 오르지 못해 작은 손실로 정리했습니다.');
          if (!diag.length) diag.push(`손실 ${tr.R}R은 손절 계획 안에서 끝난 보통 손실입니다.`);
          cool.set(si, Math.max(cool.get(si) || 0, t + (isGap ? FIXED.cooldownGap : tr.pb === 'dt' ? FIXED.dtCooldown : FIXED.cooldown)));
          if (tr.pb !== 'dt' && tr.pb !== 'bd' && tr.reason.indexOf('손절') >= 0) reviews.push({ due: t + FIXED.reviewDays, tr, i: si });
          // a stop-out after a long wait without progress counts against the waiting period
          const longWait = tr.reason.startsWith('손절') && tr.mfeR < 0.5 && (tr.pb === 'bo' ? tr.days >= Math.round(P.timeStop_bo * 0.6) : tr.pb === 'pb' && tr.days >= Math.max(3, Math.round(P.timeStop_pb * 0.6)));
          if (longWait) { diag.push(`${tr.days}거래일 동안 오르지 못하다 손절됐습니다. 기다리는 기간이 길었던 경우로 셉니다.`); timeEvidence(tr.pb, -1, chg, evid); }
        }
        // exits made by the clock or by a trailing stop are checked again 10 days later: did the price run on?
        if (tr.reason === '시간 손절' || tr.reason === '시간 청산' || tr.reason.startsWith('추적 손절(이익 보호)')) holdReviews.push({ due: t + FIXED.reviewDays, tr, i: si });
        // evidence checks (tighten when a cause repeats, relax when it has gone away)
        const fk = rate(ev.fake), pbl = rate(ev.pb), gp = count(ev.gap);
        if (tr.pb === 'bo' && ev.fake.length >= 8) {
          evid.push(`가짜 돌파 비율은 최근 돌파 매매 ${ev.fake.length}건 중 ${count(ev.fake)}건(${Math.round(fk * 100)}%)입니다.`);
          if (fk >= 0.5) { setParam('boLookback', P.boLookback + 10, chg); setParam('rsMin', P.rsMin + 5, chg); ev.fake = []; evid.push('50% 이상이라 돌파 조건을 조입니다.'); }
          else if (fk <= 0.2 && (P.boLookback > B.boLookback || P.rsMin > B.rsMin)) { toward('boLookback', 10, chg); toward('rsMin', 5, chg); ev.fake = []; evid.push('20% 이하로 줄어 조였던 돌파 조건을 한 단계 풉니다.'); }
        }
        if (tr.pb === 'pb' && ev.pb.length >= 8) {
          evid.push(`눌림목 손실 비율은 최근 ${ev.pb.length}건 중 ${count(ev.pb)}건(${Math.round(pbl * 100)}%)입니다.`);
          if (pbl >= 0.6) { setParam('pbRsi', P.pbRsi - 2, chg); setParam('pbRsMin', P.pbRsMin + 3, chg); ev.pb = []; evid.push('60%를 넘어 더 깊게 눌린 강한 종목만 사도록 바꿉니다.'); }
          else if (pbl <= 0.35 && (P.pbRsi < B.pbRsi || P.pbRsMin > B.pbRsMin)) { toward('pbRsi', 2, chg); toward('pbRsMin', 3, chg); ev.pb = []; evid.push('35% 이하로 줄어 눌림목 조건을 한 단계 풉니다.'); }
        }
        if (isGap || (ev.gap.length >= 20 && gp === 0 && P.maxPosW < B.maxPosW)) {
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
        if (tr.pb === 'dt') {
          if (ev.dtq.length >= 6) {
            const r = rate(ev.dtq);
            evid.push(`산 뒤 30분 안에 손절된 단타는 최근 ${ev.dtq.length}건 중 ${count(ev.dtq)}건입니다.`);
            if (r >= 0.5) { setParam('dtStopK', P.dtStopK + 0.1, chg); ev.dtq = []; evid.push('절반 이상이라 단타 손절 폭을 넓힙니다. 넓힌 만큼 수량을 줄여 1회 위험은 같습니다.'); }
            else if (r <= 0.2 && P.dtStopK > B.dtStopK) { toward('dtStopK', 0.1, chg); ev.dtq = []; evid.push('20% 이하로 줄어 넓혀 둔 단타 손절 폭을 한 단계 되돌립니다.'); }
          }
          if (ev.dtf.length >= 6) {
            const r = rate(ev.dtf);
            evid.push(`장 마감에 손실로 끝난 단타는 최근 ${ev.dtf.length}건 중 ${count(ev.dtf)}건입니다.`);
            if (r >= 0.5) { setParam('dtMinUp', P.dtMinUp + 0.25, chg); setParam('dtRsMin', P.dtRsMin + 5, chg); ev.dtf = []; evid.push('절반 이상이라 더 강하게 오르는 종목만 사도록 단타 조건을 조입니다.'); }
            else if (r <= 0.2 && (P.dtMinUp > B.dtMinUp || P.dtRsMin > B.dtRsMin)) { toward('dtMinUp', 0.25, chg); toward('dtRsMin', 5, chg); ev.dtf = []; evid.push('20% 이하로 줄어 조였던 단타 조건을 한 단계 풉니다.'); }
          }
          dtCount++;
          if (dtCount >= FIXED.dtPauseMin && scores.dt <= FIXED.dtPauseScore && t > dtPausedUntil) {
            dtPausedUntil = t + FIXED.dtPauseDays; dtCount = 0; scores.dt = 0;
            log(t, 'risk', '단타 일시 중지', `최근 단타 성과(평균 R, 최근 매매에 더 큰 가중)가 기준 ${FIXED.dtPauseScore}R보다 나빠 ${FIXED.dtPauseDays}거래일 동안 단타를 쉬고, 그 뒤 다시 시작합니다.`, []);
          }
        }
        if (tr.R < 0) {
          const tail = chg.length ? '' : (evid.length ? ' 아직 기준에 못 미쳐 규칙은 그대로 둡니다.' : ' 규칙은 그대로 둡니다.');
          log(t, 'loss', `${tr.sym} 손실 복기`, diag.join(' ') + (evid.length ? ' ' + evid.join(' ') : '') + tail, chg, { trade: tr });
        } else if (chg.length) {
          log(t, 'relax', `${tr.sym} ${tr.R >= 0 ? '+' : ''}${tr.R}R로 마감 · 조건 완화`, evid.join(' '), chg, { trade: tr });
        }
    }
    function timeEvidence(pbKey, v, chg, evid) {   // +1 sold too early by the clock, −1 waited too long, 0 right
      if (pbKey !== 'bo' && pbKey !== 'pb') return;
      const key = pbKey === 'bo' ? 'timeStop_bo' : 'timeStop_pb', w = pbKey === 'bo' ? ev.tbo : ev.tpb, step = pbKey === 'bo' ? 5 : 2;
      push(w, v, 8);
      const sum = w.reduce((a, b) => a + b, 0);
      if (w.length >= 6 && sum >= 3) { setParam(key, P[key] + step, chg); w.length = 0; evid.push(`너무 일찍 판 경우가 많아 기다리는 기간을 ${step}거래일 늘립니다.`); }
      else if (w.length >= 6 && sum <= -3) { setParam(key, P[key] - step, chg); w.length = 0; evid.push(`오래 기다리다 손절된 경우가 많아 기다리는 기간을 ${step}거래일 줄입니다.`); }
    }

    for (let t = from; t <= to; t++) {
      const regimeNow = regimeOk(D, t, 1);
      const prov = !!(D.prov && D.prov.t === t);     // market still open: today's prices are not final yet
      const closedToday = [];
      if (hedge) { hedge.prev = hedge.value; hedge.value *= (1 - (D.spx[t] / D.spx[t - 1] - 1)) * (1 - FIXED.hedgeExp / 252); }
      if (cash < -FIXED.marginMin && t > 0) {       // margin interest for the calendar days since the last trading day
        const owed = -cash, rate = FIXED.marginRates.find((r) => owed <= r[0])[1];
        const days = Math.max(1, Math.round((Date.parse(D.dates[t] + 'T12:00:00Z') - Date.parse(D.dates[t - 1] + 'T12:00:00Z')) / 864e5));
        const due = owed * rate / 360 * days;
        cash -= due; mInt += due;
      }
      // ── intraday: prices sampled about every 15 minutes during the session
      const snaps = D.snap && D.snap[t];
      if (snaps && snaps.length) {
        const nS = D.S.length;
        const runHi = new Float64Array(nS).fill(-Infinity);
        const spPrev = D.spx[t - 1];
        let dtOpened = 0;
        const dtDone = new Set();                       // one day trade per stock per day
        const dtOn = (!only || only === 'dt') && t > dtPausedUntil && blockUntil < t && !ddStopOn && isNum(spPrev) && spPrev > 0;
        for (let k = 0; k < snaps.length; k++) {
          const sm = snaps[k], px = sm.px, tm = sm.t;
          // a) stops, and day-trade targets, for positions already in the market at this time
          for (const p of positions.slice()) {
            if (p.pb === 'dt' ? p.k0 >= k : p.t0 >= t) continue;
            const v = px[p.i];
            if (!isNum(v) || v <= 0) continue;
            p.lastPx = v;
            if (v <= p.stop) {
              const kind = p.pb === 'dt' ? (p.stop >= p.fill ? '단타 본전 손절' : '단타 손절') : p.stop > p.stop0 + 1e-9 ? (v >= p.fill ? '추적 손절(이익 보호)' : '추적 손절') : '손절';
              learn(closeTrade(p, t, v, `${kind}, 장중 ${tm}`, tm, k), t);
              continue;
            }
            if (p.pb === 'dt') {
              p.mfeR = Math.max(p.mfeR, (v - p.fill) / p.R1);
              if (v >= p.fill + FIXED.dtTargetR * p.R1) { learn(closeTrade(p, t, v, `단타 목표가(+${FIXED.dtTargetR}R), 장중 ${tm}`, tm, k), t); continue; }
              if (v >= p.fill + p.R1) p.stop = Math.max(p.stop, p.fill);     // after +1R the stop moves up to the entry
            }
          }
          // b) day-trade entries: a strong stock making a new high of the day while the market holds up
          // a new high of the day: at the source's day high when the snapshot has it; otherwise above every earlier
          // sample, and only once the samples cover at least 20 minutes of the session
          const cover = hmMin(tm) - hmMin(snaps[0].t);
          if (dtOn && (sm.hi || cover >= 20) && tm >= FIXED.dtFrom && tm <= FIXED.dtUntil && dtOpened < FIXED.dtNewPerDay) {
            let spDay = isNum(sm.spx) ? sm.spx / spPrev - 1 : NaN;
            if (!isNum(spDay)) {          // no index level in this snapshot: median move of the list
              const mv = [];
              for (let i = 0; i < nS; i++) { const v = px[i], pc = D.S[i].c[t - 1]; if (isNum(v) && isNum(pc) && pc > 0 && D.S[i].e[t - 1]) mv.push(v / pc - 1); }
              mv.sort((a, b) => a - b);
              spDay = mv.length >= 50 ? mv[mv.length >> 1] : NaN;
            }
            if (isNum(spDay) && spDay >= FIXED.dtMktMin && positions.filter((p) => p.pb === 'dt').length < FIXED.dtMax) {
              const held = new Set(positions.map((p) => p.i));
              const cands = [];
              for (let i = 0; i < nS; i++) {
                const x = D.S[i], v = px[i], pc = x.c[t - 1];
                const newHigh = sm.hi ? isNum(sm.hi[i]) && v >= sm.hi[i] * 0.999 : isFinite(runHi[i]) && v > runHi[i];
                if (!isNum(v) || !newHigh || !isNum(pc) || pc <= 0) continue;
                if (!x.e[t - 1] || held.has(i) || dtDone.has(i) || (cool.get(i) || 0) > t) continue;
                const up = v / pc - 1;
                if (up < P.dtMinUp / 100 || up > FIXED.dtMaxUp || up - spDay < FIXED.dtRel) continue;
                if (!(x.rs[t - 1] >= P.dtRsMin) || !(pc > x.sma50[t - 1]) || !isNum(x.vol[t - 1]) || x.vol[t - 1] <= 0) continue;
                cands.push({ i, score: up - spDay, up });
              }
              cands.sort((a, b) => b.score - a.score);
              let heat = positions.reduce((sum, p) => sum + Math.max(0, p.fill - p.stop) * p.qty, 0);
              for (const cd of cands) {
                if (dtOpened >= FIXED.dtNewPerDay || positions.filter((p) => p.pb === 'dt').length >= FIXED.dtMax) break;
                const x = D.S[cd.i], v = px[cd.i];
                if (positions.filter((p) => p.pb === 'dt' && D.S[p.i].sec === x.sec).length >= 2) continue;
                const fill = v * (1 + FIXED.slip);
                const stop = fill * (1 - P.dtStopK * x.vol[t - 1]);
                const perShare = fill - stop;
                const risk = prevEq * FIXED.riskPct * FIXED.dtRiskMult * riskState.mult * riskMul('dt');
                let qty = Math.floor(risk / perShare);
                qty = Math.min(qty, Math.floor((P.maxPosW * prevEq) / fill), Math.floor(bpow(prevEq) / fill));
                if (heat + qty * perShare > FIXED.heatMax * prevEq) qty = Math.floor(Math.max(0, FIXED.heatMax * prevEq - heat) / perShare);
                if (qty < 1 || qty * fill < FIXED.minValue * prevEq) continue;
                const feeIn = catFee(qty);
                cash -= qty * fill + feeIn;
                heat += qty * perShare;
                positions.push({ id: ++idSeq, i: cd.i, pb: 'dt', t0: t, k0: k, et: tm, fill, qty, stop, stop0: stop, R1: perShare, atr: x.vol[t - 1] * v, maxC: v, mfeR: 0, miss: 0, lastPx: v, feeIn,
                  why: `장중 ${tm} 그날 고점 돌파 · 전일 대비 ${pctS(cd.up)}(S&P 500보다 ${(cd.score * 100).toFixed(1)}%p 강함) · 상대강도 상위 ${Math.max(1, 100 - x.rs[t - 1])}%`, ctx: ctxAt(t - 1) });
                held.add(cd.i);
                dtDone.add(cd.i);
                dtOpened++;
              }
            }
          }
          // c) running highs of today's samples
          for (let i = 0; i < nS; i++) { const v = px[i]; if (isNum(v) && v > runHi[i]) runHi[i] = v; }
          // d) account value at this time (last day only)
          if (t === to) {
            let eqK = cash;
            for (const p of positions) { const v = px[p.i]; eqK += p.qty * (isNum(v) ? v : isNum(p.lastPx) ? p.lastPx : price(D.S[p.i], t - 1)); }
            if (hedge) eqK += isNum(sm.spx) && isNum(spPrev) ? hedge.prev * (1 - (sm.spx / spPrev - 1)) : hedge.value;
            intraday.push({ t: tm, eq: round(eqK, 2), spx: isNum(sm.spx) ? sm.spx : null });
          }
        }
      }
      // ── exits at today's close (they wait while the market is open)
      if (!prov) for (const p of positions.slice()) {
        const x = D.S[p.i];
        if (p.pb === 'dt') {
          const v = isNum(x.c[t]) ? x.c[t] : isNum(p.lastPx) ? p.lastPx : price(x, t);
          closedToday.push(closeTrade(p, t, v, '단타 장 마감 청산', null, null));
          continue;
        }
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
        if (px <= p.stop) reason = (p.pb === 'bd' ? '채권 ' : '') + (p.stop > p.stop0 + 1e-9 ? (px >= p.fill ? '추적 손절(이익 보호)' : '추적 손절') : '손절');
        else if (p.pb === 'bd' && isNum(x.sma100[t]) && px < x.sma100[t]) reason = '채권 추세 이탈(100일 평균 아래)';
        else if (p.pb === 'pb' && px > x.sma5[t] && t > p.t0) reason = '반등 청산';
        else if (p.pb === 'pb' && t - p.t0 >= P.timeStop_pb) reason = '시간 청산';
        else if (p.pb === 'bo' && t - p.t0 >= P.timeStop_bo && p.mfeR < 0.5) reason = '시간 손절';
        if (reason) { closedToday.push(closeTrade(p, t, px, reason)); continue; }
        if (p.pb === 'bd') p.stop = Math.max(p.stop, p.maxC - P.stopK_bd * p.atr);
        if (p.pb === 'bo') {   // trailing stop moves up only; wider once the trade has made +3R, to ride the trend
          const base = regimeNow ? P.trailK : Math.min(P.trailK, 2.0);
          const k = p.mfeR >= FIXED.holdFromR ? base + P.holdK : base;
          p.stop = Math.max(p.stop, p.maxC - k * p.atr);
        }
      }

      for (const tr of closedToday) learn(tr, t);
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
          else if (w.length >= 6 && nr <= 0.2 && P[key] > B[key]) { toward(key, 0.25, chg); w.length = 0; body += ' 20% 이하로 줄어 넓혀 둔 손절 폭을 한 단계 되돌립니다.'; }
          if (noise || right || chg.length) log(t, 'review', `${tr.sym} 손절 ${FIXED.reviewDays}일 뒤 점검`, body, chg, { trade: tr });
        }
        // follow-up 10 days after an exit by the clock or by a trailing stop: did the price run on (sold too early)?
        for (const rv of holdReviews.filter((r) => r.due === t)) {
          const x = D.S[rv.i], tr = rv.tr, t1 = D.dates.indexOf(tr.exitDate);
          let hi = -Infinity;
          for (let j = t1 + 1; j <= t; j++) if (isNum(x.c[j])) hi = Math.max(hi, x.c[j]);
          if (!isFinite(hi)) continue;
          const oneR = tr.entry - tr.stop0, early = hi >= tr.exit + oneR, chg = [], evid = [];
          let title, body;
          if (tr.reason.startsWith('추적')) {
            const big = tr.mfeR >= FIXED.holdFromR, key = big ? 'holdK' : 'trailK', w = big ? ev.hold : ev.trail, step = big ? 0.5 : 0.25;
            push(w, early, 8);
            body = early ? `이익을 지키며 판 뒤 ${FIXED.reviewDays}거래일 안에 1R 넘게 더 올랐습니다(최고 ${round(hi, 2)}). 너무 일찍 판 경우입니다.` : '판 뒤 1R 넘게 더 오르지 않았습니다. 판 시점이 적절했습니다.';
            body += ` ${big ? '크게 오른 종목을' : '추적 손절로'} 너무 일찍 판 비율은 최근 ${w.length}건 중 ${count(w)}건입니다.`;
            if (w.length >= 6 && rate(w) >= 0.5) { setParam(key, P[key] + step, chg); w.length = 0; body += big ? ' 절반 이상이라 크게 오른 종목은 추적 손절을 더 넓혀 더 오래 들고 갑니다.' : ' 절반 이상이라 추적 손절 폭을 넓힙니다.'; }
            else if (w.length >= 6 && rate(w) <= 0.2 && P[key] !== B[key]) { toward(key, step, chg); w.length = 0; body += ' 20% 이하로 줄어 넓혀 둔 폭을 한 단계 되돌립니다.'; }
            title = `${tr.sym} 이익 실현 ${FIXED.reviewDays}일 뒤 점검`;
          } else {
            body = early ? `기한이 차서 판 뒤 ${FIXED.reviewDays}거래일 안에 1R 넘게 올랐습니다(최고 ${round(hi, 2)}). 기다리는 기간이 짧았던 경우로 셉니다.` : '기한이 차서 판 뒤 1R 넘게 오르지 않았습니다. 정리한 판단이 맞았습니다.';
            timeEvidence(tr.pb, early ? 1 : 0, chg, evid);
            if (evid.length) body += ' ' + evid.join(' ');
            title = `${tr.sym} 기한 매도 ${FIXED.reviewDays}일 뒤 점검`;
          }
          if (early || chg.length) log(t, 'review', title, body, chg, { trade: tr });
        }
        // market filter relaxes after 40 calm days
        if (P.regimeLevel > B.regimeLevel && t - lastMarketLoss >= 40 && D.spx[t] > D.spx50[t]) {
          const chg = []; setParam('regimeLevel', P.regimeLevel - 1, chg); lastMarketLoss = t;
          log(t, 'relax', '시장 필터 완화', '시장 때문에 생긴 손실 없이 40거래일이 지났고 S&P 500이 50일선 위에 있어 시장 필터를 한 단계 낮춥니다.', chg);
        }
        // strategy tournament: every 20 trading days each playbook runs alone over the last 120 trading days with the
        // current rules; the one with the best return per unit of drawdown gets the biggest risk budget. A playbook
        // with too few trades to judge keeps a small trial budget.
        if (!only && t - lastSelect >= FIXED.selectEvery) {
          lastSelect = t;
          // selection team check: did its top-10 list of 10 trading days ago beat the whole list of large caps?
          const t0 = t - 10;
          if (t0 > 210) {
            const pool = [];
            for (const x of D.S) { const c0 = x.c[t0], c1 = x.c[t]; if (!x.e[t0] || !isNum(c0) || !isNum(c1) || c0 <= 0) continue; pool.push({ x, r: c1 / c0 - 1, ok: c0 > x.sma50[t0] && x.sma50[t0] > x.sma200[t0] && isNum(x.rs[t0]) }); }
            const top = pool.filter((q) => q.ok).sort((a, b) => b.x.rs[t0] - a.x.rs[t0]).slice(0, 10);
            if (top.length >= 5 && pool.length >= 50) {
              const avg = (xs) => xs.reduce((a, q) => a + q.r, 0) / xs.length;
              const aT = avg(top), aA = avg(pool);
              log(t, 'pick', '종목선정팀 점검', `10거래일 전 상승 추세·상대강도 상위 10종목(${top.map((q) => q.x.s).join(', ')})은 그 뒤 평균 ${pctTxt(aT)}, 대형주 전체는 평균 ${pctTxt(aA)}였습니다. 차이 ${((aT - aA) * 100).toFixed(1)}%p.`, [], { edge: round(aT - aA, 4) });
            }
          }
          const res = {};
          for (const k of ['bo', 'pb', 'dt', 'bd']) {
            const r = simulate(D, { from: Math.max(210, t - FIXED.selectWindow + 1), to: t, capital: 100000, params: P, adaptive: false, only: k });
            res[k] = { ret: r.stats.ret, mdd: r.stats.mdd, n: r.stats.n };
          }
          const next = pickMults(res);
          if (Object.keys(M).some((k) => Math.abs(next[k] - M[k]) >= 0.05)) {
            const lvl = (m) => (m >= 0.99 ? '정상 위험' : m >= 0.45 ? '절반 위험' : m === FIXED.selectTrialM ? '1/4 위험(시험)' : '1/6 위험');
            const chg = Object.keys(M).filter((k) => Math.abs(next[k] - M[k]) >= 0.005).map((k) => ({ key: 'm_' + k, label: `${PB_NAME[k]} 1회 위험`, from: Math.round(M[k] * 100) + '%', to: Math.round(next[k] * 100) + '%' }));
            const line = (k) => (res[k].n < FIXED.selectMinTrades ? `${PB_NAME[k]} 표본 부족(${res[k].n}건)` : `${PB_NAME[k]} ${pctTxt(res[k].ret)}(최대 낙폭 ${(res[k].mdd * 100).toFixed(1)}%, ${res[k].n}건)`);
            log(t, 'budget', '전략 선택: 위험 예산 재배분', `최근 ${FIXED.selectWindow}거래일 동안 방법별로 따로 돌려 본 결과는 ${['bo', 'pb', 'dt', 'bd'].map(line).join(', ')}입니다. 수익을 최대 낙폭으로 나눈 값으로 순위를 매겨 ${['bo', 'pb', 'dt', 'bd'].map((k) => `${PB_NAME[k]}은 ${lvl(next[k])}`).join(', ')}으로 매매합니다.`, chg);
            M = next;
          }
        }
        // guard against over-fitting: every 20 days compare the adapted rules with the starting rules
        if (t - lastValidate >= FIXED.validateEvery && t - base0 >= FIXED.validateWindow && differs(P, B)) {
          lastValidate = t;
          const a = simulate(D, { from: t - FIXED.validateWindow + 1, to: t, capital: 100000, params: P, adaptive: false, mults: M });
          const b = simulate(D, { from: t - FIXED.validateWindow + 1, to: t, capital: 100000, params: B, adaptive: false, mults: M });
          const ra = a.stats.ret, rb = b.stats.ret;
          if (ra < rb - FIXED.validateMargin) {
            const chg = [];
            for (const k in DEFAULTS) setParam(k, B[k], chg);
            log(t, 'rollback', '정기 점검: 바꾼 규칙 되돌림', `최근 ${FIXED.validateWindow}거래일을 두 규칙으로 다시 돌려 보니 지금 규칙 ${pctTxt(ra)}, 출발 규칙 ${pctTxt(rb)}였습니다. 고친 규칙이 오히려 나빠 출발 규칙으로 되돌립니다.`, chg);
          } else {
            log(t, 'check', '정기 점검: 유지', `최근 ${FIXED.validateWindow}거래일 재검증 결과 지금 규칙 ${pctTxt(ra)}, 출발 규칙 ${pctTxt(rb)}입니다. 고친 규칙을 유지합니다.`, []);
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
          if (trend && x.dom[t] >= P.boLookback && x.rs[t] >= P.rsMin) { if (!only || only === 'bo') cands.push({ i, pb: 'bo', score: x.rs[t] + 0.5 }); }
          else if (c > x.sma200[t] && x.sma50[t] > x.sma200[t] && x.rs[t] >= P.pbRsMin && x.rsi2[t] < P.pbRsi) { if (!only || only === 'pb') cands.push({ i, pb: 'pb', score: x.rs[t] }); }
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
          if (positions.filter((p) => p.pb === 'bo' || p.pb === 'pb').length >= FIXED.maxPositions) { sig.why = `보유 ${FIXED.maxPositions}종목 한도`; continue; }
          if (positions.filter((p) => D.S[p.i].sec === x.sec).length >= FIXED.sectorMax) { sig.why = `같은 업종 ${FIXED.sectorMax}종목 한도`; continue; }
          const atr = x.vol[t] * c;
          const fill = c * (1 + FIXED.slip);
          const k = cd.pb === 'bo' ? P.stopK_bo : P.stopK_pb;
          const stop = fill - k * atr;
          const perShare = fill - stop;
          const risk = eq * FIXED.riskPct * mult * riskMul(cd.pb);
          let qty = Math.floor(risk / perShare);
          qty = Math.min(qty, Math.floor((P.maxPosW * eq) / fill), Math.floor(bpow(eq) / fill));
          if (heat + qty * perShare > FIXED.heatMax * eq) qty = Math.floor(Math.max(0, FIXED.heatMax * eq - heat) / perShare);
          if (qty < 1 || qty * fill < FIXED.minValue * eq) { sig.why = bpow(eq) < fill ? (P.lev > 1 ? '매수 여력(레버리지 포함) 부족' : '현금 부족') : '위험 한도(열린 위험 6%) 소진'; continue; }
          const feeIn = catFee(qty);
          cash -= qty * fill + feeIn;
          heat += qty * perShare;
          const why = cd.pb === 'bo' ? `${highTxt(x.dom[t])} 돌파(기준 ${P.boLookback}일) · 상대강도 상위 ${Math.max(1, 100 - x.rs[t])}% · 50일선이 200일선 위인 상승 추세`
            : `상승 추세(200일선 위) 속 짧은 하락: 2일 RSI ${x.rsi2[t].toFixed(1)}(기준 ${P.pbRsi} 미만) · 상대강도 상위 ${Math.max(1, 100 - x.rs[t])}%`;
          positions.push({ id: ++idSeq, i: cd.i, pb: cd.pb, t0: t, et: (D.times && D.times[t]) || null, fill, qty, stop, stop0: stop, R1: perShare, atr, maxC: c, mfeR: 0, miss: 0, feeIn, why, ctx: ctxAt(t) });
          sig.taken = true; sig.qty = qty; sig.stop = round(stop, 2);
          opened++;
        }
      }
      if (!blocked.length && !prov && (!only || only === 'bd') && D.bond0 != null && D.bond0 < D.S.length) {
        const held = new Set(positions.map((p) => p.i));
        let nb = positions.filter((p) => p.pb === 'bd').length;
        if (nb < FIXED.bdMax) {
          const cands = [];
          for (let i = D.bond0; i < D.S.length; i++) {
            const x = D.S[i], c = x.c[t];
            if (held.has(i) || (cool.get(i) || 0) > t || !isNum(c) || !isNum(x.sma100[t]) || !isNum(x.ret63[t]) || !isNum(x.vol[t]) || x.vol[t] <= 0) continue;
            if (c > x.sma100[t] && x.ret63[t] > 0) cands.push({ i, score: x.ret63[t] / (x.vol[t] * Math.sqrt(63)) });
          }
          cands.sort((a, b) => b.score - a.score);
          const eq = marked(t);
          let heat = positions.reduce((s2, p) => s2 + Math.max(0, (p.fill - p.stop)) * p.qty, 0);
          for (const [ci, cd] of cands.entries()) {
            if (nb >= FIXED.bdMax) break;
            const x = D.S[cd.i], c = x.c[t];
            const atr = x.vol[t] * c, fill = c * (1 + FIXED.slip), stop = fill - P.stopK_bd * atr, perShare = fill - stop;
            let qty = Math.floor((eq * FIXED.riskPct * riskState.mult * riskMul('bd')) / perShare);
            qty = Math.min(qty, Math.floor((P.maxPosW * eq) / fill), Math.floor(bpow(eq) / fill));
            if (heat + qty * perShare > FIXED.heatMax * eq) qty = Math.floor(Math.max(0, FIXED.heatMax * eq - heat) / perShare);
            if (qty < 1 || qty * fill < FIXED.minValue * eq) continue;
            const feeIn = x.syn ? 0 : catFee(qty);
            cash -= qty * fill + feeIn;
            heat += qty * perShare;
            const why = `가격이 100일 평균 위 · 3개월 수익 ${pctS(x.ret63[t])}${x.syn && x.ccy !== 'USD' ? '(환율 포함, 달러 기준)' : ''} · 위험 대비 수익 ${ci + 1}위(후보 ${cands.length}개)${x.yld && isNum(x.yld[t]) ? ` · 금리 ${x.yld[t].toFixed(2)}%` : ''}`;
            positions.push({ id: ++idSeq, i: cd.i, pb: 'bd', t0: t, et: (D.times && D.times[t]) || null, fill, qty, stop, stop0: stop, R1: perShare, atr, maxC: c, mfeR: 0, miss: 0, feeIn, why, ctx: ctxAt(t) });
            if (t === to) todaySignals.push({ sym: x.s, name: x.n, pb: 'bd', rs: null, price: round(c, 2), taken: true, why: '', qty, stop: round(stop, 2) });
            nb++;
          }
        }
      }
      if (t === to) signals.push(...todaySignals);

      // ── risk & hedge team: inverse S&P 500 against the stocks held overnight while the market trend is down
      if (!only && !prov) {
        const s = D.spx[t], s50 = D.spx50[t], s200 = D.spx200[t];
        let H = 0, why = '';
        if (isNum(s200) && s < s200) { H = P.hedgeK; why = 'S&P 500이 200일 평균선 아래'; }
        else if (isNum(s50) && s < s50) { H = P.hedgeK * 0.5; why = 'S&P 500이 50일 평균선 아래'; }
        const eqH = marked(t), ddH = 1 - eqH / Math.max(peak, eqH);
        if (H > 0 && ddH >= FIXED.ddHalf) { H = Math.min(1, H + 0.25); why += `, 계좌 낙폭 ${(ddH * 100).toFixed(1)}%`; }
        const longVal = positions.filter((p) => p.pb === 'bo' || p.pb === 'pb').reduce((sum, p) => sum + p.qty * price(D.S[p.i], t), 0);
        let target = H * longVal;
        if (target < FIXED.hedgeMin) target = 0;
        const cur = hedge ? hedge.value : 0;
        const tm = (D.times && D.times[t]) || null;
        // the hedge may be bought on margin when cash runs short (it lowers the account's risk); the loan pays margin interest
        if (target > cur && target - cur > Math.max(FIXED.hedgeMin, FIXED.hedgeBand * cur)) {
          const amt = target - cur, cost = amt * (1 + FIXED.slip);
          cash -= cost;
          const fresh = !hedge;
          if (!hedge) hedge = { value: 0, prev: 0, t0: t, paid: 0, got: 0, fees: 0, spx0: s };
          hedge.value += amt; hedge.paid += cost; hedge.ratio = H;
          hedgeFills.push({ side: 'buy', date: D.dates[t], time: tm, amount: round(cost, 2), spx: round(s, 2), ratio: round(H, 2), why });
          if (fresh && adaptive) log(t, 'hedge', 'S&P 500 인버스 헷지 시작', `${why}라, 다음 날로 넘기는 보유 주식 $${Math.round(longVal).toLocaleString('en-US')}의 ${Math.round(H * 100)}%만큼 S&P 500이 내리면 오르는 인버스 상품(SH와 같은 −1배)을 삽니다.`, []);
        } else if (cur > 0 && (target === 0 || cur - target > Math.max(FIXED.hedgeMin, FIXED.hedgeBand * cur))) {
          const amt = cur - target, gross = amt * (1 - FIXED.slip);
          const fee = gross > 500 ? Math.ceil(gross * secRate(D.dates[t]) * 100 - 1e-9) / 100 : 0;
          cash += gross - fee;
          hedge.value -= amt; hedge.got += gross - fee; hedge.fees += fee; hedge.ratio = H;
          hedgeFills.push({ side: 'sell', date: D.dates[t], time: tm, amount: round(gross - fee, 2), fee, spx: round(s, 2), ratio: round(H, 2), why: target === 0 ? '하락 추세가 끝나 정리' : why });
          if (target === 0) {
            const pnl = hedge.got - hedge.paid, mv = s / hedge.spx0 - 1;
            hedgeEpisodes.push({ from: D.dates[hedge.t0], to: D.dates[t], pnl: round(pnl, 2), spx: round(mv, 4) });
            if (adaptive) {
              push(ev.hedge, pnl > 0 ? 1 : -1, 6);
              const chg = [], sum = ev.hedge.reduce((a, b) => a + b, 0);
              let body = `${D.dates[hedge.t0]}부터 들고 있던 인버스 헷지를 정리했습니다. 헷지 손익 ${pnl >= 0 ? '+' : '−'}$${Math.abs(round(pnl, 2)).toLocaleString('en-US')}, 그동안 S&P 500 ${pctTxt(mv)}입니다. 최근 헷지 ${ev.hedge.length}번 중 ${ev.hedge.filter((v) => v > 0).length}번이 하락을 막았습니다.`;
              if (ev.hedge.length >= 4 && sum <= -2 && P.hedgeK > BOUNDS.hedgeK[0]) { setParam('hedgeK', P.hedgeK - 0.1, chg); ev.hedge = []; body += ' 시장이 다시 오르며 비용만 낸 경우가 많아 헷지 비율을 줄입니다.'; }
              else if (ev.hedge.length >= 4 && sum >= 2 && P.hedgeK < BOUNDS.hedgeK[1]) { setParam('hedgeK', P.hedgeK + 0.1, chg); ev.hedge = []; body += ' 하락을 막은 경우가 많아 헷지 비율을 늘립니다.'; }
              log(t, 'hedge', 'S&P 500 인버스 헷지 정리', body, chg);
            }
            hedge = null;
          }
        }
      }

      const eqEnd = marked(t);
      const ep = { date: D.dates[t], eq: round(eqEnd, 2), cash: round(cash, 2), hedge: hedge ? round(hedge.value, 2) : 0, n: positions.length, dd: round(1 - eqEnd / Math.max(peak, eqEnd), 4), bench: round(capital * D.spx[t] / D.spx[base0], 2) };
      if (D.times && D.times[t]) ep.time = D.times[t];
      if (prov) ep.prov = true;
      equity.push(ep);
      prevEq = eqEnd;
    }

    const lastT = Math.min(to, T - 1);
    // selection team: today's strongest large caps in an uptrend, and which ones are ready to buy
    const watch = [];
    if (opts.log && !only) {
      const tt = lastT;
      for (let i = 0; i < D.S.length; i++) {
        const x = D.S[i], c = price(x, tt);
        if (!x.e[tt] || !isNum(c) || !isNum(x.rs[tt]) || !(c > x.sma50[tt]) || !(x.sma50[tt] > x.sma200[tt])) continue;
        watch.push({ sym: x.s, name: x.n, sec: x.sec, rs: x.rs[tt], ret6m: round(x.ret126[tt], 4), price: round(c, 2),
          bo: x.dom[tt] >= P.boLookback && x.rs[tt] >= P.rsMin, pb: x.rsi2[tt] < P.pbRsi && x.rs[tt] >= P.pbRsMin, held: positions.some((p) => p.i === i) });
      }
      watch.sort((a, b) => b.rs - a.rs || b.ret6m - a.ret6m);
      watch.length = Math.min(watch.length, 10);
    }
    const open = positions.map((p) => {
      const x = D.S[p.i], px = price(x, lastT);
      return { id: p.id, sym: x.s, name: x.n, sec: x.sec, pb: p.pb, entryDate: D.dates[p.t0], entry: round(p.fill, 2), qty: p.qty, price: round(px, 2),
        value: round(px * p.qty, 2), pnl: round((px - p.fill) * p.qty - (p.feeIn || 0), 2), pct: round(px / p.fill - 1, 4), stop: round(p.stop, 2), stop0: round(p.stop0, 2), feeBuy: p.feeIn || 0,
        R: round((px - p.fill) / p.R1, 2), days: lastT - p.t0, riskToStop: round(Math.max(0, px - p.stop) * p.qty, 2), et: p.et || null,
        kind: x.kind || 'stock', yld: x.yld && isNum(x.yld[lastT]) ? round(x.yld[lastT], 3) : null, why: p.why || null, ctx: p.ctx || null };
    });
    // opts.snapshot: everything needed to continue after this day (a book's state), days kept relative to this day
    let snapshot = null;
    if (opts.snapshot) {
      const off = (v) => v - lastT, nm = (k) => D.S[k].s;
      snapshot = {
        P: Object.assign({}, P), base: Object.assign({}, B), scores: Object.assign({}, scores), M: Object.assign({}, M),
        ev: Object.assign(JSON.parse(JSON.stringify(ev)), { mkt: ev.mkt.map(off) }),
        cash, peak, idSeq, prevEq, dtCount, streak, ddStopOn, lastRiskKey, riskState: JSON.parse(JSON.stringify(riskState)), mInt,
        lastSelect: off(lastSelect), dtPausedUntil: off(dtPausedUntil), blockUntil: off(blockUntil), lastMarketLoss: off(lastMarketLoss), lastValidate: off(lastValidate),
        positions: positions.map((p) => { const q = Object.assign({}, p, { sym: nm(p.i), t0: off(p.t0) }); delete q.i; return q; }),
        reviews: reviews.filter((r) => r.due > lastT).map((r) => ({ due: off(r.due), tr: r.tr, sym: nm(r.i) })),
        holdReviews: holdReviews.filter((r) => r.due > lastT).map((r) => ({ due: off(r.due), tr: r.tr, sym: nm(r.i) })),
        cool: [...cool].filter(([, d]) => d > lastT).map(([k, d]) => [nm(k), off(d)]),
        hedge: hedge ? Object.assign({}, hedge, { t0: off(hedge.t0) }) : null,
      };
    }
    // a run that only reads a book back (no new day) shows the book's own last-day curve and signals
    const lastX = BK && BK.last && BK.last.date === D.dates[lastT] && from > to ? BK.last : null;
    return { from: base0, to: lastT, capital, equity, trades, open, changes, params: P, base: B, scores, mults: M, weights: normW(M), marginPaid: round(mInt, 2), lev: P.lev, dtPaused: dtPausedUntil >= lastT, evidence: ev, risk: riskState,
      signals: lastX ? lastX.signals || [] : signals, intraday: lastX ? lastX.intraday || [] : intraday, watch, snapshot, hedge: hedge ? { value: round(hedge.value, 2), since: D.dates[hedge.t0], paid: round(hedge.paid, 2), got: round(hedge.got, 2), ratio: hedge.ratio, spx0: round(hedge.spx0, 2) } : null, hedgeFills, hedgeEpisodes, stats: stats(equity, trades, capital), prov: !!(D.prov && D.prov.t === lastT) };
  }

  // ── Robinhood fees for US stocks (fee schedule checked 2026-11-18). No commission. Sells: SEC fee $20.60 per
  // $1 million from 2026-04-04 ($0 from 2025-05-14; the earlier $27.80 is from the older schedule, 확인필요), rounded
  // up to the cent, not passed on for sales of $500 or less; FINRA trading activity fee $0.000195 a share from
  // 2026-01-01 ($0.000166 before), at most $9.79 ($8.30 before), nearest cent, not passed on for 50 shares or less,
  // paused by FINRA from 2026-10-01 to 2026-12-31. Buys and sells: CAT fee $0.000003 a share (under one cent: none).
  const cent = (v) => Math.round(v * 100) / 100;
  function secRate(d) { return d >= '2026-04-04' ? 20.6e-6 : d >= '2025-05-14' ? 0 : 27.8e-6; }
  function tafRule(d) { if (d >= '2026-10-01' && d <= '2026-12-31') return null; return d >= '2026-01-01' ? [0.000195, 9.79] : [0.000166, 8.3]; }
  function catFee(qty) { const v = qty * 0.000003; return v < 0.01 ? 0 : cent(v); }
  function sellFee(qty, px, d) {
    const notional = qty * px;
    const sec = notional > 500 ? Math.ceil(notional * secRate(d) * 100 - 1e-9) / 100 : 0;
    const tr = tafRule(d);
    const taf = tr && qty > 50 ? Math.min(tr[1], cent(qty * tr[0])) : 0;
    const cat = catFee(qty);
    return { sec, taf, cat, total: cent(sec + taf + cat) };
  }
  function hmMin(hm) { return /^\d\d:\d\d$/.test(hm || '') ? +hm.slice(0, 2) * 60 + +hm.slice(3) : NaN; }
  function normW(w) {
    const sum = (w.bo || 0) + (w.pb || 0) + (w.dt || 0) + (w.bd || 0) || 1;
    return { bo: round((w.bo || 0) / sum, 3), pb: round((w.pb || 0) / sum, 3), dt: round((w.dt || 0) / sum, 3), bd: round((w.bd || 0) / sum, 3) };
  }
  // ranks the playbooks by return ÷ max drawdown: the best trades with the normal 1-trade risk, the second with half,
  // the third with a sixth; one that lost money gets at most a sixth; one with too few trades to judge a quarter (trial)
  function pickMults(res) {
    const keys = Object.keys(res), M = {};
    const ranked = keys.filter((k) => res[k].n >= FIXED.selectMinTrades).map((k) => ({ k, sc: res[k].ret / Math.max(res[k].mdd, 0.02) })).sort((a, b) => b.sc - a.sc);
    keys.forEach((k) => (M[k] = FIXED.selectTrialM));
    ranked.forEach((r, j) => { const tier = FIXED.selectTiers[Math.min(j, FIXED.selectTiers.length - 1)]; M[r.k] = r.sc > 0 ? tier : Math.min(tier, FIXED.selectLoserM); });
    return M;
  }
  function differs(P, B) { const R = B || DEFAULTS; for (const k in DEFAULTS) if (P[k] !== R[k]) return true; return false; }
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
      fees: Math.round(trades.reduce((s, t) => s + (t.fee || 0), 0) * 100) / 100,
      realized: Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
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
    // the live account starts from a fixed snapshot of what the past test learned (settings.warm), so that a later
    // change to the engine does not rewrite the account's starting rules; without a snapshot the test is run here
    const fw = settings && settings.warm;
    const bt = fw ? null : simulate(D, { from: bi, to: li - 1, capital, params: DEFAULTS, adaptive: true, log: true });
    const start = fw ? { params: Object.assign({}, DEFAULTS, fw.params), scores: fw.scores, mults: fw.mults, evidence: fw.evidence } : { params: bt.params, scores: bt.scores, mults: bt.mults, evidence: bt.evidence };
    const warm = Object.assign({}, start.params);
    let lv = null;
    if (liveReady) {
      lv = simulate(D, { from: li, to: T - 1, capital, params: warm, scores: start.scores, mults: start.mults, evidence: start.evidence, adaptive: true, log: true });
      lv.changes.unshift({ date: D.dates[li], t: li, kind: 'start', title: '연습 계좌 시작', body: `시작 자금 $${capital.toLocaleString('en-US')}. 과거 검증(${D.dates[bi]}~${D.dates[li - 1]}) 동안 스스로 고친 규칙에서 출발합니다.${fw ? ` (출발 상태 고정: ${fw.saved || ''})` : ''}`, changes: Object.keys(DEFAULTS).filter((k) => warm[k] !== DEFAULTS[k]).map((k) => ({ key: k, label: LABELS[k], from: DEFAULTS[k], to: warm[k] })) });
    }
    return {
      D: { dates: D.dates, last: D.dates[T - 1], lastTime: D.times[T - 1] || null, prov: D.prov ? { date: D.dates[D.prov.t], time: D.prov.time } : null, liveDays: D.liveDays, notes: D.notes, symbols: D.S.length },
      regime: regimeText(D, T - 1), spxLast: D.spx[T - 1],
      gate: { ok: regimeOk(D, T - 1, (lv ? lv.params : warm).regimeLevel), level: (lv ? lv.params : warm).regimeLevel, spx: round(D.spx[T - 1], 2), spx50: round(D.spx50[T - 1], 2), spx200: round(D.spx200[T - 1], 2) },
      bt, live: lv, warm, start: fw ? null : { params: bt.params, scores: bt.scores, mults: bt.mults, evidence: bt.evidence }, liveStart, liveStartIdx: li, capital,
    };
  }

  // ── 4. The live account as a book ─────────────────────────────────────────────────────────────────────
  // A trading day goes into the book (data/book.json) once its closing prices are final, and every later run continues
  // from the book instead of recomputing those days. Fills in the book never change, whatever later happens to the
  // engine, to the rules (the evolution lab) or to the price files.
  const VERSION = 'v4';
  function lastFinalIdx(D) { return D.prov ? D.prov.t - 1 : D.dates.length - 1; }
  function bookOf(D, res, from0, capital) {
    return {
      v: 1, engine: VERSION, date: D.dates[res.to], from0, capital, saved: new Date().toISOString(),
      state: res.snapshot,
      hist: { equity: res.equity, trades: res.trades, changes: res.changes, hedgeFills: res.hedgeFills, hedgeEpisodes: res.hedgeEpisodes },
      last: { date: D.dates[res.to], intraday: res.intraday, signals: res.signals },
    };
  }
  // o: {book, warm, capital, liveStart, btStart}. Returns the book through the last day with final prices and the days added.
  function advanceBook(D, o) {
    const lf = lastFinalIdx(D);
    const li = D.dates.findIndex((d) => d >= o.liveStart);
    if (li < 0 || lf < li) return { book: o.book || null, added: [] };
    if (o.book) {
      const tb = D.dates.indexOf(o.book.date);
      if (tb < 0) throw new Error('book day missing from the price data: ' + o.book.date);
      if (tb >= lf) return { book: o.book, added: [] };
      const res = simulate(D, { resume: o.book, to: lf, adaptive: true, log: true, snapshot: true });
      return { book: bookOf(D, res, o.book.from0, o.book.capital), added: D.dates.slice(tb + 1, lf + 1) };
    }
    // first book: the account from its first day, starting from the fixed snapshot of what the past test learned
    const w = o.warm, capital = o.capital;
    const P0 = Object.assign({}, DEFAULTS, w.params);
    const res = simulate(D, { from: li, to: lf, capital, params: P0, scores: w.scores, mults: w.mults, evidence: w.evidence, adaptive: true, log: true, snapshot: true });
    const bi = D.dates.findIndex((d) => d >= (o.btStart || '2025-01-02'));
    res.changes.unshift({ date: D.dates[li], t: li, kind: 'start', title: '연습 계좌 시작', body: `시작 자금 $${capital.toLocaleString('en-US')}. 과거 검증(${D.dates[bi]}~${D.dates[li - 1]}) 동안 스스로 고친 규칙에서 출발합니다. (출발 상태 고정: ${w.saved || ''})`, changes: Object.keys(DEFAULTS).filter((k) => P0[k] !== DEFAULTS[k]).map((k) => ({ key: k, label: LABELS[k], from: DEFAULTS[k], to: P0[k] })) });
    return { book: bookOf(D, res, D.dates[li], capital), added: D.dates.slice(li, lf + 1) };
  }
  // market state on the last day, for the page
  function marketView(D, P) {
    const t = D.dates.length - 1, lvl = (P || DEFAULTS).regimeLevel;
    return { regime: regimeText(D, t), spxLast: D.spx[t], gate: { ok: regimeOk(D, t, lvl), level: lvl, spx: round(D.spx[t], 2), spx50: round(D.spx50[t], 2), spx200: round(D.spx200[t], 2) } };
  }

  // ── what the account leans on now and why: the engine's own budgets (the 20-day method tournament), the market filter,
  // the loss brakes and the bond filter, read together with the macro picture. Nothing here changes a trade.
  function macroView(D, res) {
    if (!res) return null;
    const t = res.to, P = res.params, m = macroAt(D, t), M = res.mults || {}, rk = res.risk || {};
    const lvl = P.regimeLevel, gate = regimeOk(D, t, lvl), blocked = (rk.blocked || []).length > 0, mult = isNum(rk.mult) ? rk.mult : 1;
    const bonds = [];
    if (D.bond0 != null) for (let i = D.bond0; i < D.S.length; i++) {
      const x = D.S[i], c = x.c[t];
      if (isNum(c) && x.sma100 && isNum(x.sma100[t]) && isNum(x.ret63[t]) && isNum(x.vol[t]) && x.vol[t] > 0 && c > x.sma100[t] && x.ret63[t] > 0) bonds.push({ n: x.n.replace('(합성)', ''), score: x.ret63[t] / (x.vol[t] * Math.sqrt(63)) });
    }
    bonds.sort((a, b) => b.score - a.score);
    const gateWhy = !(m.spx > D.spx200[t]) ? `S&P 500이 200일선 아래(${pctS(m.d200)})` : lvl >= 2 && !(m.spx > D.spx50[t]) ? `S&P 500이 50일선 아래(${pctS(m.d50)})` : '변동성이 평소의 1.25배를 넘어';
    const brakeWhy = (rk.blocked || []).join(' ');
    const rateTxt = !isNum(m.dy2) ? '미국 금리 자료 없음' : `미 2년 금리 3개월 ${ppS(m.dy2)}(${m.rates === 'falling' ? '금리 하락, 인하 기대' : m.rates === 'rising' ? '금리 상승, 긴축 압력' : '보합'})`;
    const risky = m.trend !== 'up' || m.volLv === 'high';
    const items = [
      { k: 'bo', on: gate && !blocked, budget: (M.bo || 0) * mult,
        why: !gate ? `${gateWhy}라 새 매수를 쉽니다. 하락 추세에서는 신고가를 넘은 종목도 되밀리기 쉽습니다.` : blocked ? brakeWhy
          : `S&P 500 ${m.trend === 'up' ? `상승 추세(200일선 ${pctS(m.d200)})` : '시장 필터 통과'}: 신고가를 넘은 강한 종목이 추세를 이어 가기 쉬운 장입니다.` },
      { k: 'pb', on: gate && !blocked, budget: (M.pb || 0) * mult,
        why: !gate ? `${gateWhy}라 새 매수를 쉽니다. 하락 추세의 눌림은 반등보다 추가 하락이 잦습니다.` : blocked ? brakeWhy
          : `상승 추세 안의 짧은 하락을 삽니다${m.volLv === 'high' ? '. 변동성이 커 이런 눌림이 자주 생깁니다' : ''}.` },
      { k: 'dt', on: !res.dtPaused && !blocked, budget: (M.dt || 0) * mult,
        why: res.dtPaused ? '최근 단타 성과가 나빠 잠시 쉽니다.' : blocked ? brakeWhy
          : `밤사이 주식을 들고 있지 않아${risky ? ' 하락 추세·큰 변동성의 위험을 피하면서' : ''} 그날 시장보다 강한 종목만 짧게 노립니다.` },
      { k: 'bd', on: !blocked && bonds.length > 0, budget: (M.bd || 0) * mult,
        why: blocked ? brakeWhy : bonds.length ? `${rateTxt}. 가격이 오르는 채권 ${bonds.length}종(${bonds.slice(0, 3).map((b) => b.n).join(', ')})이 매수 조건을 통과했습니다.`
          : `${rateTxt}. 매수 조건(100일 평균 위·3개월 수익 플러스)을 통과한 채권이 없습니다.` },
    ];
    const pref = risky ? ['dt', 'bd', 'pb', 'bo'] : ['bo', 'pb', 'dt', 'bd'];
    items.sort((a, b) => (b.on - a.on) || (b.budget - a.budget) || (pref.indexOf(a.k) - pref.indexOf(b.k)));
    let r = 0;
    for (const it of items) { it.name = PB_NAME[it.k]; it.budget = round(it.budget, 3); it.rank = it.on ? ++r : null; }
    const mood = m.trend === 'down' || (m.trend === 'mixed' && m.volLv === 'high') ? 'off' : m.trend === 'up' && m.volLv !== 'high' ? 'on' : 'mixed';
    const state = m.trend === 'down' ? (m.volLv === 'high' ? '주식 하락 추세·변동성 확대' : '주식 하락 추세') : m.trend === 'mixed' ? (m.volLv === 'high' ? '주식 약세·변동성 확대' : '주식 약세(50일선 아래)') : m.volLv === 'high' ? '주식 상승 추세·변동성 큼' : '주식 상승 추세·안정';
    const rate = m.rates === 'falling' ? '미 금리 하락(인하 기대)' : m.rates === 'rising' ? '미 금리 상승(긴축 압력)' : isNum(m.dy2) ? '미 금리 보합' : '';
    const tops = items.filter((i) => i.on).slice(0, 2).map((i) => i.name);
    const headline = `${state}${rate ? ', ' + rate : ''} → ${tops.length ? tops.join('·') + ' 우선' : '새 매매 쉼'}`;
    const lab = (v, a) => a[v] || '';
    const signals = [
      { k: 'S&P 500 추세', v: lab(m.trend, { up: '상승', mixed: '약세', down: '하락' }), c: m.trend === 'up' ? 'up' : 'down', sub: `200일선 ${pctS(m.d200)} · 50일선 ${pctS(m.d50)}` },
      isNum(m.vol) ? { k: '변동성(20일, 연율)', v: (m.vol * 100).toFixed(1) + '%', sub: `1년 평균 ${isNum(m.volL) ? (m.volL * 100).toFixed(1) + '%' : '-'} · ${lab(m.volLv, { high: '높음', normal: '보통', low: '낮음' })}` } : null,
      isNum(m.y2) ? { k: '미 2년 금리', v: m.y2.toFixed(2) + '%', sub: `3개월 ${isNum(m.dy2) ? ppS(m.dy2) : '-'} · ${lab(m.rates, { falling: '하락', rising: '상승', flat: '보합' })}` } : null,
      isNum(m.curve) ? { k: '장단기 금리차(10년−2년)', v: ppS(m.curve), sub: m.curve < 0 ? '역전: 경기 둔화 신호' : m.curve < 0.5 ? '평평' : '정상' } : null,
      isNum(m.gl) ? { k: '세계 10년 금리', v: '3개월 ' + ppS(m.gl), sub: `${m.glN}개국 중앙값 · ${lab(m.glDir, { falling: '하락', rising: '상승', flat: '보합' })}` } : null,
    ].filter(Boolean);
    return { date: m.date, mood, headline, items, signals, gate: { ok: gate, level: lvl } };
  }

  const api = { VERSION, DEFAULTS, BOUNDS, LABELS, UNITS, FIXED, PB_NAME, TEAMS, TEAM_OF, teamsOf, prepare, simulate, runAll, regimeText, regimeOk, lastFinalIdx, advanceBook, marketView, macroAt, macroView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperEngine = api;
})(typeof self !== 'undefined' ? self : this);
