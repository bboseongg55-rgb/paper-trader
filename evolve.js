/* 진화 연구소 (evolution lab) for the paper-trading engine.
   Every evening after a trading day closes, the lab trades its shadow accounts through the day, and when a place is
   free it makes small variations of the live rules and tests each one on the past year, split into two halves of 125 trading days. A variation that beats the live rules in both halves
   (more return, a better return-to-drawdown ratio, a drawdown at most 2 points deeper, at least 15 trades) starts
   trading in a shadow account: the same prices and the same account at its start, but no fills in the real book.
   Day-trade rules cannot be tested on the past prices (they have no intraday samples), so one shadow always tries a
   day-trade variation forward only. After at least 20 trading days, a shadow that made at least 1 percentage point
   more than the live account, with a drawdown at most 1 point deeper and at least 4 closed trades, becomes the next
   generation of rules from the next trading day. The rules it replaced keep trading in a shadow, so a step that
   turns out worse can be taken back the same way. A shadow ends after 40 trading days, or after 10 if it is 2 points
   or more behind. Fills already in the book never change. The fixed risk limits (1-trade risk, open risk, loss stops)
   are not part of what evolves, and a candidate's market filter, position size and hedge ratio are never looser than
   the live account's starting rules. */
(function (root) {
  'use strict';

  const LAB = {
    screened: 2, forward: 1, tries: 16,
    screenDays: 125, screenMinTrades: 15, screenMinGain: 0.002, screenMddSlack: 0.02,
    fwdMin: 20, fwdMax: 40, earlyAt: 10, earlyCut: -0.02,
    margin: 0.01, mddSlack: 0.01, minTrades: 4,
    historyMax: 60,
  };
  // one step of change for each rule
  const STEP = { stopK_bo: 0.25, stopK_pb: 0.25, trailK: 0.25, boLookback: 10, rsMin: 5, pbRsMin: 3, pbRsi: 2, regimeLevel: 1, maxPosW: 0.02,
    timeStop_bo: 5, timeStop_pb: 2, holdK: 0.5, dtStopK: 0.1, dtMinUp: 0.25, dtRsMin: 5, hedgeK: 0.1, stopK_bd: 0.25, lev: 0.25 };
  const DT_KEYS = ['dtStopK', 'dtMinUp', 'dtRsMin'];
  const PAST_KEYS = Object.keys(STEP).filter((k) => !DT_KEYS.includes(k));
  const INT = new Set(['boLookback', 'regimeLevel', 'rsMin', 'pbRsMin', 'pbRsi', 'timeStop_bo', 'timeStop_pb', 'dtRsMin']);
  const fix = (k, v) => (k === 'maxPosW' ? Math.round(v * 1000) / 1000 : INT.has(k) ? Math.round(v) : Math.round(v * 100) / 100);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // limits for evolution: the engine's own limits, and the risk team's rules never looser than at the account's start
  const limits = (E) => Object.assign({}, E.BOUNDS, { regimeLevel: [1, 3], maxPosW: [0.08, 0.15], hedgeK: [0.3, 1] });
  const keyOf = (E, P) => Object.keys(E.DEFAULTS).map((k) => P[k]).join('|');
  const pct = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%';
  const dayKo = (d) => `${+d.slice(5, 7)}월 ${+d.slice(8, 10)}일`;

  // the same evening always makes the same candidates
  function rng(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    let a = h;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function mutate(P, keys, rnd, L, n) {
    const Q = Object.assign({}, P), pool = keys.slice();
    const m = n || (rnd() < 0.5 ? 1 : rnd() < 0.7 ? 2 : 3);
    for (let j = 0; j < m && pool.length; j++) {
      const k = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const steps = (rnd() < 0.75 ? 1 : 2) * (rnd() < 0.5 ? -1 : 1);
      Q[k] = fix(k, clamp(P[k] + steps * STEP[k], L[k][0], L[k][1]));
    }
    return Q;
  }
  function diff(E, A, B) {
    return Object.keys(E.DEFAULTS).filter((k) => A[k] !== B[k]).map((k) => ({ key: k, label: E.LABELS[k], from: A[k], to: B[k], team: E.TEAM_OF[k] }));
  }
  // the past year in two halves, with the live account's current risk shares
  function screen(E, D, td, Q, M) {
    const n = LAB.screenDays;
    return [[td - 2 * n + 1, td - n], [td - n + 1, td]].map(([a, b]) => {
      const r = E.simulate(D, { from: a, to: b, capital: 100000, params: Q, adaptive: false, mults: M });
      const s = r.stats;
      return { from: D.dates[Math.max(210, a)], to: D.dates[b], ret: s.ret, mdd: s.mdd, n: s.n, fit: s.ret / Math.max(s.mdd, 0.02) };
    });
  }
  const passes = (s, z) => s.every((w, i) => w.n >= LAB.screenMinTrades && w.ret >= z[i].ret + LAB.screenMinGain && w.fit > z[i].fit && w.mdd <= z[i].mdd + LAB.screenMddSlack);
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const briefS = (w) => ({ from: w.from, to: w.to, ret: r4(w.ret), mdd: r4(w.mdd), n: w.n });
  const briefF = (f) => (f ? { age: f.age, ret: r4(f.ret), champRet: r4(f.champRet), excess: r4(f.excess), mdd: r4(f.mdd), champMdd: r4(f.champMdd), trades: f.trades, champTrades: f.champTrades, open: f.open } : null);

  // a shadow account traded from its first day through day td, next to the live account over the same days
  function forward(E, D, book, sh, td) {
    const r = E.simulate(D, { resume: { date: sh.born, from0: book.from0, capital: book.capital, state: sh.state, hist: {} }, to: td, adaptive: true, log: false });
    const rows = r.equity, eq0 = sh.eq0, end = D.dates[td];
    // the live account's rows, with money moved out to the crypto account added back (a move is not a loss)
    // (moves the shadow's starting state already had are left as they are)
    const seen = new Set(sh.seen || []), flows = (book.flows || []).filter((f) => !seen.has(f.id));
    const live = book.hist.equity.filter((e) => e.date > sh.born && e.date <= end).map((e) => ({ eq: e.eq - flows.filter((f) => f.date < e.date).reduce((s, f) => s + f.amount, 0) }));
    const mdd = (xs) => { let pk = eq0, m = 0; for (const e of xs) { pk = Math.max(pk, e.eq); m = Math.max(m, 1 - e.eq / pk); } return m; };
    const last = (xs) => (xs.length ? xs[xs.length - 1].eq : eq0);
    const ret = last(rows) / eq0 - 1, champRet = last(live) / eq0 - 1;
    return { age: rows.length, ret, champRet, excess: ret - champRet, mdd: mdd(rows), champMdd: mdd(live), trades: r.trades.length,
      champTrades: book.hist.trades.filter((t) => t.exitDate > sh.born && t.exitDate <= end).length, open: r.open.length, params: r.params, asOf: end };
  }
  function note(evo, e) { evo.history.push(e); if (evo.history.length > LAB.historyMax) evo.history.splice(0, evo.history.length - LAB.historyMax); }
  function spawn(E, evo, book, kind, P, base, d, scr) {
    const st = JSON.parse(JSON.stringify(book.state));
    st.P = Object.assign({}, P); st.base = Object.assign({}, base);
    const eqs = book.hist.equity, moved = (book.flows || []).filter((f) => f.date >= book.date).reduce((s, f) => s + f.amount, 0);
    const sh = { id: ++evo.seq, kind, born: book.date, eq0: (eqs.length ? eqs[eqs.length - 1].eq : book.capital) + moved, seen: (book.flows || []).map((f) => f.id), params: Object.assign({}, P), base: Object.assign({}, base), diff: d, screen: scr || null, state: st, fwd: null };
    evo.shadows.push(sh);
    note(evo, { date: book.date, type: 'born', id: sh.id, kind, diff: d, screen: scr || null });
    return sh;
  }

  // one evening, after the book has taken in day book.date. Returns the book (new rules from the next day if a shadow
  // was promoted) and the lab's new state.
  function night(E, D, book, evo0) {
    const evo = evo0 ? JSON.parse(JSON.stringify(evo0)) : { v: 1, gen: 0, since: book.from0, seq: 0, shadows: [], history: [], lastRun: null, lastScreen: null };
    const day = book.date, td = D.dates.indexOf(day);
    if (td < 0) throw new Error('lab: book day missing from the price data: ' + day);
    if (evo.lastRun && evo.lastRun >= day) return { book, evo, changed: false, promoted: null };
    const t0 = Date.now(), L = limits(E);
    let out = book, promoted = null;
    // 1. every shadow trades through today
    for (const sh of evo.shadows) sh.fwd = forward(E, D, book, sh, td);
    // 2. the shadow furthest ahead among those that met every condition becomes the next generation
    const ok = (f) => f.age >= LAB.fwdMin && f.excess >= LAB.margin && f.mdd <= f.champMdd + LAB.mddSlack && f.trades >= LAB.minTrades;
    const ready = evo.shadows.filter((sh) => ok(sh.fwd)).sort((a, b) => b.fwd.excess - a.fwd.excess);
    if (ready.length) {
      const w = ready[0], f = w.fwd;
      out = JSON.parse(JSON.stringify(book));
      const oldP = out.state.P, oldBase = out.state.base;
      out.state.P = Object.assign({}, f.params);
      out.state.base = Object.assign({}, w.base);
      const chg = diff(E, oldP, out.state.P).map(({ key, label, from, to }) => ({ key, label, from, to }));
      evo.gen += 1; evo.since = day;
      out.hist.changes.push({ date: day, t: td, kind: 'evolve', title: `진화: ${evo.gen}세대 규칙으로 교체`,
        body: `도전자 #${w.id}이 ${dayKo(w.born)} 다음 거래일부터 ${f.age}거래일 동안 그림자 계좌에서 ${pct(f.ret, 2)}(최대 낙폭 ${(f.mdd * 100).toFixed(1)}%)를 냈고, 같은 기간 지금 규칙은 ${pct(f.champRet, 2)}(최대 낙폭 ${(f.champMdd * 100).toFixed(1)}%)였습니다. ${(LAB.margin * 100).toFixed(0)}%p 넘게 앞서고 낙폭도 크지 않아 다음 거래일부터 이 규칙으로 매매합니다. 바꾸기 전 규칙은 그림자 계좌에서 계속 시험해, 더 나으면 같은 방식으로 되돌아갑니다.`,
        changes: chg, teams: E.teamsOf('evolve', chg) });
      for (const sh of evo.shadows) if (sh !== w) note(evo, { date: day, type: 'retire', id: sh.id, kind: sh.kind, diff: sh.diff, why: '세대 교체로 시험 종료', fwd: briefF(sh.fwd) });
      note(evo, { date: day, type: 'promote', id: w.id, kind: w.kind, diff: chg, gen: evo.gen, fwd: briefF(f) });
      promoted = { id: w.id, gen: evo.gen, diff: chg, fwd: briefF(f) };
      evo.shadows = [];
      spawn(E, evo, out, 'previous', oldP, oldBase, diff(E, out.state.P, oldP), null);
    } else {
      // 3. shadows that ran out of time, or fell well behind, end
      evo.shadows = evo.shadows.filter((sh) => {
        const g = sh.fwd;
        const why = g.age >= LAB.fwdMax ? `${LAB.fwdMax}거래일 동안 승격 조건을 채우지 못함`
          : g.age >= LAB.earlyAt && g.excess <= LAB.earlyCut ? `지금 규칙보다 ${Math.abs(LAB.earlyCut * 100).toFixed(0)}%p 넘게 뒤처짐` : null;
        if (why) note(evo, { date: day, type: 'retire', id: sh.id, kind: sh.kind, diff: sh.diff, why, fwd: briefF(g) });
        return !why;
      });
    }
    // 4. new candidates for the free places
    const champ = out.state;
    const seen = new Set([keyOf(E, champ.P), ...evo.shadows.map((s) => keyOf(E, s.params))]);
    const nS = evo.shadows.filter((s) => s.kind === 'screened').length;
    if (nS < LAB.screened) {
      const rnd = rng(`${day}|${evo.gen}|${evo.seq}|past`);
      const z = screen(E, D, td, champ.P, champ.M);
      const tested = [];
      for (let k = 0; k < LAB.tries * 4 && tested.length < LAB.tries; k++) {
        const Q = mutate(champ.P, PAST_KEYS, rnd, L);
        const kq = keyOf(E, Q);
        if (seen.has(kq)) continue;
        seen.add(kq);
        tested.push({ Q, s: screen(E, D, td, Q, champ.M) });
      }
      const pass = tested.filter((c) => passes(c.s, z)).map((c) => Object.assign(c, { gain: c.s[0].fit - z[0].fit + c.s[1].fit - z[1].fit })).sort((a, b) => b.gain - a.gain);
      evo.lastScreen = { date: day, tried: tested.length, passed: pass.length, champ: z.map(briefS),
        best: pass[0] ? { diff: diff(E, champ.P, pass[0].Q), s: pass[0].s.map(briefS) } : null };
      for (const c of pass.slice(0, LAB.screened - nS)) spawn(E, evo, out, 'screened', c.Q, c.Q, diff(E, champ.P, c.Q), { cand: c.s.map(briefS), champ: z.map(briefS) });
    }
    if (evo.shadows.filter((s) => s.kind === 'forward').length < LAB.forward) {
      const rnd = rng(`${day}|${evo.gen}|${evo.seq}|forward`);
      for (let k = 0; k < 30; k++) {
        const Q = mutate(champ.P, DT_KEYS, rnd, L, 1), kq = keyOf(E, Q);
        if (seen.has(kq)) continue;
        spawn(E, evo, out, 'forward', Q, Q, diff(E, champ.P, Q), null);
        break;
      }
    }
    evo.lastRun = day;
    evo.ms = Date.now() - t0;
    delete evo.lastError;
    return { book: out, evo, changed: true, promoted };
  }

  // what the page shows
  function view(E, evo) {
    if (!evo) return null;
    return {
      gen: evo.gen, since: evo.since, lastRun: evo.lastRun, error: evo.lastError || null,
      rules: { tries: LAB.tries, screenDays: LAB.screenDays, fwdMin: LAB.fwdMin, fwdMax: LAB.fwdMax, margin: LAB.margin, mddSlack: LAB.mddSlack, minTrades: LAB.minTrades, earlyAt: LAB.earlyAt, earlyCut: LAB.earlyCut },
      shadows: evo.shadows.map((s) => ({ id: s.id, kind: s.kind, born: s.born, diff: s.diff, fwd: briefF(s.fwd), screen: s.screen })),
      lastScreen: evo.lastScreen,
      history: evo.history.slice(-15).reverse(),
    };
  }

  const api = { LAB, STEP, night, view, screen, forward, mutate, rng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperLab = api;
})(typeof self !== 'undefined' ? self : this);
