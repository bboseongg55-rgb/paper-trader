/* 코인 계좌: 24시간 돌아가는 코인 자동매매 연습 엔진 (거래소 공개 호가, 가상 자금).
   Three strategies share the crypto account, each with its own money and rules:
   - arb (거래소 간 차익거래): the account keeps dollars and coins at five US exchanges. When one exchange's best bid,
     after its taker fee, is above another's best ask plus its fee by more than a small buffer, it buys where it is cheap
     and sells where it is dear at those displayed prices, up to the displayed sizes. Moving coins between exchanges to
     rebalance pays a network fee. Quotes are polled about every 15 seconds, so a real arbitrage robot (milliseconds)
     would see far more chances and fill at worse prices: these fills are the ones that were still there at the poll.
   - trend (추세): hourly bars; buys a new 20-hour high above the 100-hour average, stop 3 × ATR below, trailing, sells
     on a 10-hour low. One position per coin.
   - scalp (초단타): one-minute bars; buys a break of the last 15 minutes' high after a fast 5-minute rise, takes +0.5%,
     stops at −0.35%, or leaves after 20 minutes.
   - tok (토큰화 주식): US stocks and ETFs as Kraken xStocks tokens, traded around the clock at Kraken's displayed bid and
     ask (taker fee 0.08%, 확인필요): the same hourly trend rule as the coins, only when the spread is under 0.3%.
   Trend and scalp trade on the cheapest exchange (Binance.US). Every 24 hours the AI re-weights trend and scalp by
   their last 7 days (best gets full risk, second half, a loser a sixth, too few trades a quarter). Account brakes: a 3%
   loss within a UTC day stops new trades for the rest of the day; a 15% drawdown halves risk; 25% stops new trades. */
(function (root) {
  'use strict';
  const COINS = ['BTC', 'ETH', 'SOL'];
  // tokenized US stocks and ETFs at Kraken (xStocks): symbol → name
  const TOKS = { SPYx: 'S&P 500 ETF', QQQx: '나스닥 100 ETF', IWMx: '러셀 2000 ETF(중소형주)', NVDAx: '엔비디아', TSLAx: '테슬라', AAPLx: '애플', MSFTx: '마이크로소프트',
    GOOGLx: '알파벳', AMZNx: '아마존', METAx: '메타', AVGOx: '브로드컴', GLDx: '금 ETF' };
  const TOK_FEE = 0.0008;
  // taker fees at the entry tier for a US account (checked 2026-11-18 from public fee schedules and reviews):
  // Coinbase Advanced 0.90% (since 2026-09-16), Kraken Pro 0.80% (since 2026-07-09), Bitstamp 0.40%,
  // Gemini ActiveTrader 1.20%, Binance.US 0.02%
  const VENUES = {
    coinbase: { name: 'Coinbase', taker: 0.009 },
    kraken: { name: 'Kraken', taker: 0.008 },
    bitstamp: { name: 'Bitstamp', taker: 0.004 },
    gemini: { name: 'Gemini', taker: 0.012 },
    binanceus: { name: 'Binance.US', taker: 0.0002 },
  };
  // network fee for moving a coin between exchanges (typical withdrawal fees; varies by exchange and network, 확인필요)
  const WD_FEE = { BTC: 0.0002, ETH: 0.002, SOL: 0.01 };
  const CFG = {
    arbShare: 0.3, arbMinEdge: 0.0005, arbMaxUsd: 1500, slip: 0.0002, exec: 'binanceus',
    trend: { hi: 20, lo: 10, atr: 14, ema: 100, stopK: 3, risk: 0.01, maxW: 0.3, shortW: 1 },
    // perpetual futures for the trend strategy: longs and shorts, up to `lev` times the margin. Each position keeps its
    // margin (notional ÷ lev) aside; funding and borrowing cost `fund` a year on the notional (확인필요: real funding swings
    // around this and is often paid to shorts); a position is closed before 80% of its margin could be lost. Shorts start
    // at shortW of the long risk (owner's setting: the same as longs)
    perp: { lev: 5, fund: 0.08, guard: 0.8, gross: 3 },       // owner's setting (2026-11-21): up to 5× margin, all perpetual notional together ≤ 3 × the coin account
    // tokenized stocks and gold (RWA) trade as perpetual-style positions: long on a 20-hour high, short on a 20-hour low,
    // up to `lev` × margin, all token notional ≤ gross × the account. Outside US market hours and at weekends the quotes
    // widen: spreads up to offSpread are accepted there, at offSize × the risk (owner's setting, 2026-11-21)
    tok: { hi: 20, lo: 10, atr: 14, ema: 100, stopK: 3, risk: 0.005, maxW: 0.2, maxAll: 0.6, maxSpread: 0.003, lev: 3, gross: 1.5, offSpread: 0.008, offSize: 0.5 },
    scalp: { look: 15, mom: 0.003, tp: 0.005, sl: 0.0035, maxMin: 20, risk: 0.0025, maxW: 0.2 },
    brakes: { day: 0.03, half: 0.15, stop: 0.25 },
    reweightMs: 24 * 3600e3, reviewMs: 7 * 24 * 3600e3, trialW: 0.25, tiers: [1, 0.5], loserW: 0.17, minTrades: 5,
    keepFills: 300, keepMin: 2 * 1440, keepHour: 90 * 24, keepBarsH: 300, keepBarsM: 120,
    // staking: ETH and SOL held earn the public liquid-staking yield (Lido stETH 7-day average, Marinade mSOL 30-day),
    // less an exchange commission of 25% (확인필요); until the first fetch, 2.5% and 5.5% (확인필요). The dollars waiting
    // at the exchanges earn USDC rewards at the account's RP rate (확인필요). Rewards are added to the same balances.
    stake: { coins: ['ETH', 'SOL'], fallback: { ETH: 0.025, SOL: 0.055 }, cut: 0.25 },
  };
  const r2 = (v) => Math.round(v * 100) / 100;
  const r8 = (v) => Math.round(v * 1e8) / 1e8;
  const f8 = (v) => Math.floor(v * 1e8) / 1e8;        // quantities round down, never above what is there
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const med = (xs) => { const a = xs.filter(isNum).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN; };
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  // the middle price of each coin: the median of the exchanges' mid prices
  function mids(q) {
    const out = {};
    for (const c of COINS) out[c] = med(Object.values(q.books || {}).map((b) => (b && b[c] && b[c].bid > 0 && b[c].ask > 0 ? (b[c].bid + b[c].ask) / 2 : NaN)));
    return out;
  }
  function equity(st, m) {
    let v = 0;
    const px = (c) => (isNum(m[c]) ? m[c] : st.last[c] || 0);
    for (const k in st.venues) { const a = st.venues[k]; v += a.usd; for (const c of COINS) v += (a.coin[c] || 0) * px(c); }
    v += st.trade.usd; for (const c of COINS) v += (st.trade.coin[c] || 0) * px(c);
    if (st.tok) for (const k in st.tok.hold) { const qq = st.tok.q[k]; if (qq && qq.mid > 0) v += st.tok.hold[k] * qq.mid; }
    if (st.tok) for (const k in st.tok.pos) { const p = st.tok.pos[k], qq = st.tok.q[k]; if (p && p.perp) v += p.margin + p.side * p.qty * (((qq && qq.mid) || p.entry) - p.entry); }
    for (const s of ['trend', 'scalp']) for (const c in (st.pos && st.pos[s]) || {}) { const p = st.pos[s][c]; if (p && p.perp) v += p.margin + p.side * p.qty * (px(c) - p.entry); }
    return v;
  }
  const tokState = (st) => (st.tok = st.tok || { hold: {}, pos: {}, bars: {}, q: {} });
  function fill(st, f) { st.fills.push(f); if (st.fills.length > CFG.keepFills) st.fills.splice(0, st.fills.length - CFG.keepFills); }

  // a new account: part of the money spread over the exchanges for arbitrage (half dollars, half coins), the rest in
  // dollars at the trading exchange for the trend and scalp strategies
  function init(capital, q, now) {
    const m = mids(q), venues = {};
    for (const k in VENUES) venues[k] = { usd: 0, coin: Object.fromEntries(COINS.map((c) => [c, 0])) };
    const st = { v: 1, start: now, funded: 0, venues, trade: { usd: 0, coin: Object.fromEntries(COINS.map((c) => [c, 0])) }, pos: { trend: {}, scalp: {} }, bars: { h: {}, m: {} }, fills: [], eqMin: [], eqHour: [], closes: {},
      w: { trend: CFG.trialW, scalp: CFG.trialW }, lastReweight: now, peak: 0, day: { date: utcDay(now), eq: 0 }, last: {}, spreads: {}, transfers: [], stats: { arb: { n: 0, pnl: 0, fees: 0 }, trend: { n: 0, pnl: 0, fees: 0 }, scalp: { n: 0, pnl: 0, fees: 0 }, tok: { n: 0, pnl: 0, fees: 0 }, moves: { n: 0, fees: 0 } }, log: [],
      tok: { hold: {}, pos: {}, bars: {}, q: {} } };
    for (const c of COINS) st.last[c] = m[c];
    if (capital > 0) fund(st, capital, q, now, 'start');
    return st;
  }
  // money in (or out) from the main account; arbitrage inventory is topped up to its share, the rest goes to trading cash
  function fund(st, amount, q, now, id) {
    const m = mids(q), ks = Object.keys(VENUES);
    st.funded += amount;
    if (amount > 0) {
      const arb = amount * CFG.arbShare, rest = amount - arb, per = arb / ks.length;
      for (const k of ks) {
        st.venues[k].usd += per / 2;
        for (const c of COINS) if (m[c] > 0) st.venues[k].coin[c] += (per / 2 / COINS.length) / m[c];
      }
      st.trade.usd += rest;
    } else {                                // money out: trading dollars first, then the exchanges' arbitrage dollars
      let need = -amount;
      const take = Math.min(need, Math.max(0, st.trade.usd)); st.trade.usd -= take; need -= take;
      const ks2 = Object.keys(VENUES);
      for (const k of ks2) { if (need <= 0) break; const x = Math.min(need, Math.max(0, st.venues[k].usd)); st.venues[k].usd -= x; need -= x; }
    }
    st.peak = Math.max(st.peak + amount, equity(st, m));
    st.day.eq += amount;
    st.transfers.push({ id, t: now, amount: r2(amount) });
    st.log.push({ t: now, kind: 'fund', text: `${amount >= 0 ? 'AI 배분으로 계좌 안에서 받음' : 'AI 배분으로 계좌 안 다른 운용에 보냄'} $${Math.abs(r2(amount)).toLocaleString('en-US')}` });
    return st;
  }
  // dollars that can leave the 24-hour market now without selling anything
  function freeUsd(st) { return Math.max(0, st.trade.usd) + Object.values(st.venues).reduce((a, v) => a + Math.max(0, v.usd), 0); }

  // ── arbitrage across exchanges (each pair, each coin, both directions)
  function arb(st, q, now) {
    const ks = Object.keys(VENUES).filter((k) => q.books[k]);
    for (const c of COINS) {
      let best = null;
      for (const a of ks) for (const b of ks) {
        if (a === b) continue;
        const A = q.books[a][c], B = q.books[b][c];
        if (!A || !B || !(A.ask > 0) || !(B.bid > 0)) continue;
        const buy = A.ask * (1 + VENUES[a].taker + CFG.slip), sell = B.bid * (1 - VENUES[b].taker - CFG.slip);
        const edge = sell / buy - 1;
        if (!best || edge > best.edge) best = { a, b, edge, gross: B.bid / A.ask - 1, buy, sell };
      }
      if (!best) continue;
      st.spreads[c] = { buyAt: best.a, sellAt: best.b, gross: Math.round(best.gross * 1e5) / 1e5, net: Math.round(best.edge * 1e5) / 1e5, t: now };
      if (best.edge <= CFG.arbMinEdge) continue;
      const A = q.books[best.a][c], B = q.books[best.b][c], va = st.venues[best.a], vb = st.venues[best.b];
      let qty = Math.min(isNum(A.askSz) ? A.askSz : 1000 / A.ask, isNum(B.bidSz) ? B.bidSz : 1000 / B.bid, va.usd / best.buy, vb.coin[c], CFG.arbMaxUsd / A.ask);
      if (!(qty * A.ask >= 10)) continue;                        // at least $10 a trade
      qty = f8(qty);
      const cost = qty * best.buy, got = qty * best.sell, fee = qty * A.ask * VENUES[best.a].taker + qty * B.bid * VENUES[best.b].taker;
      va.usd -= cost; va.coin[c] += qty; vb.coin[c] -= qty; vb.usd += got;
      const pnl = got - cost;
      st.stats.arb.n++; st.stats.arb.pnl += pnl; st.stats.arb.fees += fee;
      fill(st, { t: now, s: 'arb', c, side: 'arb', qty, buyAt: best.a, sellAt: best.b, buy: r2(A.ask), sell: r2(B.bid), fee: r2(fee), pnl: r2(pnl), edge: Math.round(best.edge * 1e5) / 1e5 });
    }
    rebalance(st, q, now);
  }
  // when an exchange runs low on a coin, move coins from the exchange with the most (network fee); dollars move free
  function rebalance(st, q, now) {
    const ks = Object.keys(VENUES), m = mids(q);
    for (const c of COINS) {
      if (!(m[c] > 0)) continue;
      const tot = ks.reduce((s, k) => s + st.venues[k].coin[c], 0), tgt = tot / ks.length;
      if (!(tgt * m[c] >= 20)) continue;
      const lo = ks.reduce((x, k) => (st.venues[k].coin[c] < st.venues[x].coin[c] ? k : x), ks[0]);
      const hi = ks.reduce((x, k) => (st.venues[k].coin[c] > st.venues[x].coin[c] ? k : x), ks[0]);
      if (st.venues[lo].coin[c] >= tgt * 0.1 || lo === hi) continue;
      const mv = f8(Math.min(tgt - st.venues[lo].coin[c], st.venues[hi].coin[c] - tgt));
      if (!(mv * m[c] >= 50 * WD_FEE[c] * m[c])) continue;
      st.venues[hi].coin[c] -= mv; st.venues[lo].coin[c] += mv - WD_FEE[c];
      st.stats.moves.n++; st.stats.moves.fees += WD_FEE[c] * m[c];
      fill(st, { t: now, s: 'move', c, side: 'move', qty: mv, from: hi, to: lo, fee: r2(WD_FEE[c] * m[c]) });
    }
    // dollars: keep each exchange's arbitrage dollars near the average (bank transfers, no fee assumed)
    const arbUsd = ks, avg = arbUsd.reduce((s, k) => s + st.venues[k].usd, 0) / arbUsd.length;
    for (const k of arbUsd) if (st.venues[k].usd < avg * 0.25) {
      const rich = arbUsd.reduce((x, j) => (st.venues[j].usd > st.venues[x].usd ? j : x), arbUsd[0]);
      const mv = Math.min(avg - st.venues[k].usd, st.venues[rich].usd - avg);
      if (mv >= 50) { st.venues[rich].usd -= mv; st.venues[k].usd += mv; }
    }
  }

  // ── bars from the polled prices
  function bar(list, t0, px, keep) {
    const b = list[list.length - 1];
    if (b && b.t === t0) { b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.c = px; return false; }
    list.push({ t: t0, o: px, h: px, l: px, c: px });
    if (list.length > keep) list.splice(0, list.length - keep);
    return !!b;                                                 // true when a bar just closed
  }
  const ema = (xs, n) => { let e = NaN; const k = 2 / (n + 1); for (const x of xs) e = isNum(e) ? e + k * (x - e) : x; return e; };
  function atr(bs, n) { const tr = []; for (let i = Math.max(1, bs.length - n); i < bs.length; i++) tr.push(Math.max(bs[i].h - bs[i].l, Math.abs(bs[i].h - bs[i - 1].c), Math.abs(bs[i].l - bs[i - 1].c))); return tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : NaN; }

  function buy(st, s, c, qty, px, now, why, extra) {
    const v = st.trade, f = VENUES[CFG.exec].taker, fillPx = px * (1 + CFG.slip), fee = qty * fillPx * f;
    v.usd -= qty * fillPx + fee; v.coin[c] += qty;
    st.stats[s].fees += fee;
    const p = Object.assign({ c, qty, entry: fillPx, t0: now, fee, why }, extra || {});
    st.pos[s][c] = p;
    fill(st, { t: now, s, c, side: 'buy', qty, px: r2(fillPx), fee: r2(fee), why });
    return p;
  }
  function perpOpen(st, s, c, side, qty, px, now, why, extra) {
    const v = st.trade, f = VENUES[CFG.exec].taker, fillPx = px * (1 + side * CFG.slip), fee = qty * fillPx * f, margin = (qty * fillPx) / CFG.perp.lev;
    v.usd -= margin + fee;
    st.stats[s].fees += fee;
    const p = Object.assign({ c, qty, entry: fillPx, side, perp: true, lev: CFG.perp.lev, margin, t0: now, fee, fund: 0, why }, extra || {});
    st.pos[s][c] = p;
    fill(st, { t: now, s, c, side: side > 0 ? 'buy' : 'short', qty, px: r2(fillPx), fee: r2(fee), why, perp: true, lev: CFG.perp.lev });
    return p;
  }
  function perpClose(st, s, c, px, now, why) {
    const p = st.pos[s][c], v = st.trade, f = VENUES[CFG.exec].taker, fillPx = px * (1 - p.side * CFG.slip), fee = p.qty * fillPx * f;
    const gross = p.side * p.qty * (fillPx - p.entry);
    v.usd += p.margin + gross - fee;
    const pnl = gross - fee - p.fee - (p.fund || 0), R = p.risk > 0 ? pnl / p.risk : 0;
    st.stats[s].n++; st.stats[s].pnl += pnl; st.stats[s].fees += fee;
    (st.closed = st.closed || []).push({ t: now, s, c, pnl: r2(pnl), R: Math.round(R * 100) / 100, side: p.side });
    if (st.closed.length > 500) st.closed.splice(0, st.closed.length - 500);
    fill(st, { t: now, s, c, side: p.side > 0 ? 'sell' : 'cover', qty: p.qty, px: r2(fillPx), fee: r2(fee), pnl: r2(pnl), why, held: Math.round((now - p.t0) / 60e3), perp: true });
    delete st.pos[s][c];
  }
  // closes a position whichever kind it is (spot held from before, or perpetual)
  const exitPos = (st, s, c, B, now, why) => { const p = st.pos[s][c]; if (p.perp) perpClose(st, s, c, p.side > 0 ? B.bid : B.ask, now, why); else sell(st, s, c, B.bid, now, why); };
  function sell(st, s, c, px, now, why) {
    const p = st.pos[s][c], v = st.trade, f = VENUES[CFG.exec].taker, fillPx = px * (1 - CFG.slip), fee = p.qty * fillPx * f;
    v.usd += p.qty * fillPx - fee; v.coin[c] -= p.qty;
    const pnl = p.qty * (fillPx - p.entry) - fee - p.fee, R = p.risk > 0 ? pnl / p.risk : 0;
    st.stats[s].n++; st.stats[s].pnl += pnl; st.stats[s].fees += fee;
    (st.closed = st.closed || []).push({ t: now, s, c, pnl: r2(pnl), R: Math.round(R * 100) / 100 });
    if (st.closed.length > 500) st.closed.splice(0, st.closed.length - 500);
    fill(st, { t: now, s, c, side: 'sell', qty: p.qty, px: r2(fillPx), fee: r2(fee), pnl: r2(pnl), why, held: Math.round((now - p.t0) / 60e3) });
    delete st.pos[s][c];
  }

  // one poll of the exchanges: arbitrage, then stops and signals, brakes, re-weighting, the equity record
  // staking rewards since the last poll (a gap of more than two days, when the loop was off, earns nothing)
  function stake(st, now, m) {
    const S = (st.stake = st.stake || { at: now, rates: {}, earned: {} });
    const dt = (now - (S.at || now)) / (365 * 864e5);
    S.at = now;
    if (!(dt > 0) || dt > 2 / 365) return;
    if (!st.stats.stake) st.stats.stake = { n: 0, pnl: 0, fees: 0 };
    for (const c of CFG.stake.coins) {
      const r = (isNum(S.rates[c]) ? S.rates[c] : CFG.stake.fallback[c]) * (1 - CFG.stake.cut);
      if (!(r > 0)) continue;
      let got = 0;
      for (const k in st.venues) { const a = st.venues[k], add = (a.coin[c] || 0) * r * dt; if (add > 0) { a.coin[c] += add; got += add; } }
      const tq = st.trade.coin[c] || 0, add = tq * r * dt;
      if (add > 0) { st.trade.coin[c] = tq + add; got += add; }
      S.earned[c] = (S.earned[c] || 0) + got;
      if (isNum(m[c])) st.stats.stake.pnl += got * m[c];
    }
    const ur = isNum(S.rates.USD) ? S.rates.USD : 0;
    if (ur > 0) {
      let got = 0;
      for (const k in st.venues) { const a = st.venues[k]; if (a.usd > 0) { const add = a.usd * ur * dt; a.usd += add; got += add; } }
      if (st.trade.usd > 0) { const add = st.trade.usd * ur * dt; st.trade.usd += add; got += add; }
      S.earned.USD = (S.earned.USD || 0) + got; st.stats.stake.pnl += got;
    }
  }
  function step(st, q, now) {
    const m = mids(q);
    for (const c of COINS) if (isNum(m[c])) st.last[c] = m[c];
    stake(st, now, m);
    arb(st, q, now);
    const ex = q.books[CFG.exec];
    let eq = equity(st, m);
    if (utcDay(now) !== st.day.date) st.day = { date: utcDay(now), eq };
    st.peak = Math.max(st.peak, eq);
    const dd = st.peak > 0 ? 1 - eq / st.peak : 0, dayLoss = st.day.eq > 0 ? 1 - eq / st.day.eq : 0;
    const stopNew = dayLoss >= CFG.brakes.day || dd >= CFG.brakes.stop, half = dd >= CFG.brakes.half ? 0.5 : 1;
    st.brake = { stopNew, half, dd: Math.round(dd * 1e4) / 1e4, dayLoss: Math.round(dayLoss * 1e4) / 1e4 };
    for (const c of COINS) {
      if (!isNum(m[c])) continue;
      const B = ex && ex[c];
      // bars
      const hb = (st.bars.h[c] = st.bars.h[c] || []), mb = (st.bars.m[c] = st.bars.m[c] || []);
      const hClosed = bar(hb, Math.floor(now / 3600e3) * 3600e3, m[c], CFG.keepBarsH), mClosed = bar(mb, Math.floor(now / 60e3) * 60e3, m[c], CFG.keepBarsM);
      if (!B || !(B.bid > 0) || !(B.ask > 0)) continue;
      // scalp: exits on every poll
      const sp = st.pos.scalp[c];
      if (sp) {
        if (B.bid >= sp.entry * (1 + CFG.scalp.tp)) sell(st, 'scalp', c, B.bid, now, '목표가');
        else if (B.bid <= sp.entry * (1 - CFG.scalp.sl)) sell(st, 'scalp', c, B.bid, now, '손절');
        else if (now - sp.t0 >= CFG.scalp.maxMin * 60e3) sell(st, 'scalp', c, B.bid, now, '시간 청산');
      }
      // trend: funding, the margin guard and the stop on every poll
      const tp = st.pos.trend[c];
      if (tp && tp.perp) {
        const yrs = Math.max(0, now - (tp.fAt || tp.t0)) / (365 * 864e5);
        if (yrs > 0 && yrs < 2 / 365) { const cost = tp.qty * m[c] * CFG.perp.fund * yrs; st.trade.usd -= cost; tp.fund = (tp.fund || 0) + cost; st.stats.trend.fees += cost; }
        tp.fAt = now;
      }
      if (tp && tp.perp && -tp.side * tp.qty * ((tp.side > 0 ? B.bid : B.ask) - tp.entry) >= CFG.perp.guard * tp.margin) exitPos(st, 'trend', c, B, now, '증거금 80% 손실: 강제 청산 전 정리');
      else if (tp && (tp.side < 0 ? B.ask >= tp.stop : B.bid <= tp.stop)) exitPos(st, 'trend', c, B, now, (tp.side < 0 ? tp.stop < tp.stop0 : tp.stop > tp.stop0) ? '추적 손절' : '손절');
      // trend: signals on a closed hourly bar
      if (hClosed && hb.length > CFG.trend.ema) {
        const done = hb.slice(0, -1), last = done[done.length - 1], prev = done.slice(-CFG.trend.hi - 1, -1);
        const a = atr(done, CFG.trend.atr), e = ema(done.map((b) => b.c), CFG.trend.ema);
        const p = st.pos.trend[c];
        if (p && p.side < 0) {                                   // a short: the stop trails down; out on a 10-hour high
          p.loC = Math.min(p.loC || Infinity, last.c);
          p.stop = Math.min(p.stop, p.loC + CFG.trend.stopK * a);
          const hi = Math.max(...done.slice(-CFG.trend.lo - 1, -1).map((b) => b.h));
          if (last.c > hi) exitPos(st, 'trend', c, B, now, `${CFG.trend.lo}시간 최고가 돌파`);
        } else if (p) {
          p.hiC = Math.max(p.hiC || 0, last.c);
          p.stop = Math.max(p.stop, p.hiC - CFG.trend.stopK * a);
          const lo = Math.min(...done.slice(-CFG.trend.lo - 1, -1).map((b) => b.l));
          if (last.c < lo) exitPos(st, 'trend', c, B, now, `${CFG.trend.lo}시간 최저가 이탈`);
        } else if (!stopNew && a > 0 && ((last.c > Math.max(...prev.map((b) => b.h)) && last.c > e) || (last.c < Math.min(...prev.map((b) => b.l)) && last.c < e))) {
          // a new 20-hour high above the 100-hour average → long; a new 20-hour low below it → short (perpetual, up to
          // perp.lev × margin); size by risk to the stop, at most maxW × lev of the account in notional
          const side = last.c > e ? 1 : -1, px = side > 0 ? B.ask : B.bid;
          const risk = eq * CFG.trend.risk * st.w.trend * tiltOf(st, 'trend') * half * (side > 0 ? 1 : CFG.trend.shortW), per = CFG.trend.stopK * a;
          const gross = Object.values(st.pos.trend).reduce((g, q2) => g + (q2 && q2.perp ? q2.qty * (st.last[q2.c] || q2.entry) : 0), 0);
          let qty = Math.min(risk / per, (CFG.trend.maxW * CFG.perp.lev * eq) / px, (st.trade.usd * CFG.perp.lev) / (px * 1.02), Math.max(0, CFG.perp.gross * eq - gross) / px);
          qty = f8(qty);
          const stop = px + (side > 0 ? -per : per);
          const why = side > 0 ? `${CFG.trend.hi}시간 신고가(${r2(last.c)})·100시간 평균(${r2(e)}) 위: 무기한 선물 매수(최대 ${CFG.perp.lev}배), 손절 ${r2(stop)}(1시간 변동폭의 ${CFG.trend.stopK}배)`
            : `${CFG.trend.hi}시간 신저가(${r2(last.c)})·100시간 평균(${r2(e)}) 아래: 무기한 선물 공매도(최대 ${CFG.perp.lev}배), 손절 ${r2(stop)}(1시간 변동폭의 ${CFG.trend.stopK}배)`;
          if (qty * px >= 20) perpOpen(st, 'trend', c, side, qty, px, now, why, { stop, stop0: stop, hiC: last.c, loC: last.c, risk: qty * per });
        }
      }
      // scalp: signals on a closed minute bar
      if (mClosed && mb.length > CFG.scalp.look + 2 && !st.pos.scalp[c] && !stopNew) {
        const done = mb.slice(0, -1), last = done[done.length - 1], prev = done.slice(-CFG.scalp.look - 1, -1), c5 = done[done.length - 6];
        if (c5 && last.c > Math.max(...prev.map((b) => b.h)) && last.c / c5.c - 1 > CFG.scalp.mom) {
          const risk = eq * CFG.scalp.risk * st.w.scalp * tiltOf(st, 'scalp') * half, per = B.ask * CFG.scalp.sl;
          let qty = Math.min(risk / per, (CFG.scalp.maxW * eq) / B.ask, st.trade.usd / (B.ask * 1.01));
          qty = f8(qty);
          if (qty * B.ask >= 20) buy(st, 'scalp', c, qty, B.ask, now, `15분 고점 돌파·5분 +${(CFG.scalp.mom * 100).toFixed(1)}% 이상`, { risk: qty * per });
        }
      }
    }
    toks(st, q, now, eq, stopNew, half);
    // the AI re-weights trend and scalp by their last 7 days
    if (now - st.lastReweight >= CFG.reweightMs) {
      st.lastReweight = now;
      const recent = (st.closed || []).filter((x) => now - x.t <= CFG.reviewMs);
      const sc = {};
      for (const s of ['trend', 'scalp']) { const xs = recent.filter((x) => x.s === s); sc[s] = { n: xs.length, R: xs.reduce((a, x) => a + x.R, 0) }; }
      const ranked = Object.keys(sc).filter((s) => sc[s].n >= CFG.minTrades).sort((a, b) => sc[b].R - sc[a].R);
      const w = { trend: CFG.trialW, scalp: CFG.trialW };
      ranked.forEach((s, j) => { const tier = CFG.tiers[Math.min(j, CFG.tiers.length - 1)]; w[s] = sc[s].R > 0 ? tier : Math.min(tier, CFG.loserW); });
      if (w.trend !== st.w.trend || w.scalp !== st.w.scalp) st.log.push({ t: now, kind: 'weight', text: `최근 7일 성과로 위험 배분을 바꿉니다: 추세 ${Math.round(st.w.trend * 100)}% → ${Math.round(w.trend * 100)}%, 초단타 ${Math.round(st.w.scalp * 100)}% → ${Math.round(w.scalp * 100)}% (추세 ${sc.trend.n}건 ${sc.trend.R.toFixed(1)}R, 초단타 ${sc.scalp.n}건 ${sc.scalp.R.toFixed(1)}R)` });
      st.w = w;
    }
    if (st.log.length > 100) st.log.splice(0, st.log.length - 100);
    // equity record: one point a minute (two days), one an hour (90 days), and each UTC day's last value
    eq = equity(st, m);
    const tm = Math.floor(now / 60e3) * 60e3, th = Math.floor(now / 3600e3) * 3600e3;
    const lm = st.eqMin[st.eqMin.length - 1];
    if (lm && lm[0] === tm) lm[1] = r2(eq); else st.eqMin.push([tm, r2(eq)]);
    if (st.eqMin.length > CFG.keepMin) st.eqMin.splice(0, st.eqMin.length - CFG.keepMin);
    const lh = st.eqHour[st.eqHour.length - 1];
    if (lh && lh[0] === th) lh[1] = r2(eq); else st.eqHour.push([th, r2(eq)]);
    if (st.eqHour.length > CFG.keepHour) st.eqHour.splice(0, st.eqHour.length - CFG.keepHour);
    st.closes[utcDay(now)] = r2(eq);
    st.eq = r2(eq); st.at = now;
    return st;
  }

  const tiltOf = (st, k) => (st.tilt && isNum(st.tilt[k]) ? st.tilt[k] : 1);
  const NYF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  function usOpen(now) { const p = Object.fromEntries(NYF.formatToParts(new Date(now)).map((x) => [x.type, x.value])), m = +p.hour * 60 + +p.minute; return !['Sat', 'Sun'].includes(p.weekday) && m >= 570 && m < 960; }
  // ── tokenized stocks at Kraken: hourly trend, only with a tight spread, at the displayed bid and ask
  function toks(st, q, now, eq, stopNew, half) {
    const T = tokState(st), K = CFG.tok, quotes = q.toks || {};
    if (!st.stats.tok) st.stats.tok = { n: 0, pnl: 0, fees: 0 };
    for (const k of Object.keys(TOKS)) {
      const x = quotes[k];
      if (!x || !(x.bid > 0) || !(x.ask >= x.bid)) continue;
      const mid = (x.bid + x.ask) / 2, spr = x.ask / x.bid - 1;
      T.q[k] = { bid: x.bid, ask: x.ask, mid, t: now };
      const hb = (T.bars[k] = T.bars[k] || []);
      const closed = bar(hb, Math.floor(now / 3600e3) * 3600e3, mid, CFG.keepBarsH);
      const p = T.pos[k];
      if (p && p.perp) {
        const yrs = Math.max(0, now - (p.fAt || p.t0)) / (365 * 864e5);
        if (yrs > 0 && yrs < 2 / 365) { const cost = p.qty * mid * CFG.perp.fund * yrs; st.trade.usd -= cost; p.fund = (p.fund || 0) + cost; st.stats.tok.fees += cost; }
        p.fAt = now;
        if (-p.side * p.qty * ((p.side > 0 ? x.bid : x.ask) - p.entry) >= CFG.perp.guard * p.margin) { tokSell(st, k, p.side > 0 ? x.bid : x.ask, now, '증거금 80% 손실: 강제 청산 전 정리'); continue; }
      }
      if (p && (p.side < 0 ? x.ask >= p.stop : x.bid <= p.stop)) tokSell(st, k, p.side < 0 ? x.ask : x.bid, now, (p.side < 0 ? p.stop < p.stop0 : p.stop > p.stop0) ? '추적 손절' : '손절');
      if (!closed || hb.length <= K.ema) continue;
      const done = hb.slice(0, -1), last = done[done.length - 1], prev = done.slice(-K.hi - 1, -1);
      const a = atr(done, K.atr), e = ema(done.map((b) => b.c), K.ema);
      const p2 = T.pos[k];
      if (p2 && p2.side < 0) {
        p2.loC = Math.min(p2.loC || Infinity, last.c);
        p2.stop = Math.min(p2.stop, p2.loC + K.stopK * a);
        const hi = Math.max(...done.slice(-K.lo - 1, -1).map((b) => b.h));
        if (last.c > hi) tokSell(st, k, x.ask, now, `${K.lo}시간 최고가 돌파`);
      } else if (p2) {
        p2.hiC = Math.max(p2.hiC || 0, last.c);
        p2.stop = Math.max(p2.stop, p2.hiC - K.stopK * a);
        const lo = Math.min(...done.slice(-K.lo - 1, -1).map((b) => b.l));
        if (last.c < lo) tokSell(st, k, x.bid, now, `${K.lo}시간 최저가 이탈`);
      } else {
        const off = !usOpen(now), sprMax = off ? K.offSpread : K.maxSpread;
        const longSig = last.c > Math.max(...prev.map((b) => b.h)) && last.c > e, shortSig = last.c < Math.min(...prev.map((b) => b.l)) && last.c < e;
        if (!stopNew && spr <= sprMax && a > 0 && (longSig || shortSig)) {
          const side = longSig ? 1 : -1, px = side > 0 ? x.ask : x.bid;
          const gross = Object.values(T.pos).reduce((g, q2) => g + (q2 && q2.perp ? q2.qty * ((T.q[q2.c] && T.q[q2.c].mid) || q2.entry) : 0), 0)
            + Object.keys(T.hold).reduce((s2, j) => s2 + (T.hold[j] || 0) * ((T.q[j] && T.q[j].mid) || 0), 0);
          const tilt = tiltOf(st, 'tok') * (k === 'IWMx' ? tiltOf(st, 'tokSmall') : 1);
          const risk = eq * K.risk * tilt * half * (off ? K.offSize : 1), per = K.stopK * a;
          let qty = Math.min(risk / per, (K.maxW * K.lev * eq) / px, Math.max(0, K.gross * eq - gross) / px, (st.trade.usd * K.lev) / (px * (1 + TOK_FEE) * 1.02));
          qty = f8(qty);
          if (qty * px >= 20) {
            const fee = qty * px * TOK_FEE, margin = (qty * px) / K.lev, stop = px - side * per;
            st.trade.usd -= margin + fee; st.stats.tok.fees += fee;
            const why = `${TOKS[k]} 토큰: ${K.hi}시간 ${side > 0 ? '신고가' : '신저가'}(${r2(last.c)})·100시간 평균(${r2(e)}) ${side > 0 ? '위: 매수' : '아래: 공매도'}(증거금 최대 ${K.lev}배)${tilt !== 1 ? `, AI 배분 ${Math.round(tilt * 100)}%` : ''}. ${off ? '미국 장 밖·주말이라 크기 절반, ' : ''}호가 차이 ${(spr * 100).toFixed(2)}%, 손절 ${r2(stop)}`;
            T.pos[k] = { c: k, qty, entry: px, side, perp: true, lev: K.lev, margin, t0: now, fee, fund: 0, stop, stop0: stop, hiC: last.c, loC: last.c, risk: qty * per, why };
            fill(st, { t: now, s: 'tok', c: k, side: side > 0 ? 'buy' : 'short', qty, px: r2(px), fee: r2(fee), why, perp: true, lev: K.lev });
          }
        }
      }
    }
  }
  function tokSell(st, k, px, now, why) {
    const T = tokState(st), p = T.pos[k], fee = p.qty * px * TOK_FEE;
    let pnl;
    if (p.perp) { const gross = p.side * p.qty * (px - p.entry); st.trade.usd += p.margin + gross - fee; pnl = gross - fee - p.fee - (p.fund || 0); }
    else { st.trade.usd += p.qty * px - fee; T.hold[k] = (T.hold[k] || 0) - p.qty; if (T.hold[k] < 1e-9) delete T.hold[k]; pnl = p.qty * (px - p.entry) - fee - p.fee; }
    const R = p.risk > 0 ? pnl / p.risk : 0;
    st.stats.tok.n++; st.stats.tok.pnl += pnl; st.stats.tok.fees += fee;
    (st.closed = st.closed || []).push({ t: now, s: 'tok', c: k, pnl: r2(pnl), R: Math.round(R * 100) / 100 });
    fill(st, { t: now, s: 'tok', c: k, side: p.perp && p.side < 0 ? 'cover' : 'sell', qty: p.qty, px: r2(px), fee: r2(fee), pnl: r2(pnl), why, held: Math.round((now - p.t0) / 60e3), perp: p.perp || undefined });
    delete T.pos[k];
  }
  // what the page shows
  function view(st) {
    if (!st) return null;
    const m = st.last, hold = [];
    for (const c of COINS) {
      const arbQ = Object.values(st.venues).reduce((s, a) => s + (a.coin[c] || 0), 0), trQ = st.trade.coin[c] || 0, q = arbQ + trQ;
      if (q > 1e-9) hold.push({ c, qty: r8(q), arb: r8(arbQ), trade: r8(trQ), price: r2(m[c] || 0), value: r2(q * (m[c] || 0)) });
    }
    const usd = Object.values(st.venues).reduce((s, a) => s + a.usd, 0) + st.trade.usd;
    // each coin's hourly trend as the trend strategy sees it: the last closed bar against the 100-hour average and the 20-hour high
    const mkt = {};
    for (const c of COINS) {
      const hb = (st.bars.h[c] || []).slice(0, -1);
      if (hb.length <= CFG.trend.ema) continue;
      const last = hb[hb.length - 1], e = ema(hb.map((b) => b.c), CFG.trend.ema), hi = Math.max(...hb.slice(-CFG.trend.hi - 1, -1).map((b) => b.h)), c24 = hb.length > 24 ? hb[hb.length - 25].c : NaN;
      mkt[c] = { px: r2(last.c), ema: r2(e), hi: r2(hi), up: last.c > e, d24: isNum(c24) ? Math.round((last.c / c24 - 1) * 1e4) / 1e4 : null };
    }
    return {
      v: 1, at: st.at, start: st.start, funded: r2(st.funded), eq: st.eq, usd: r2(usd), hold, last: st.last,
      venues: Object.fromEntries(Object.entries(st.venues).map(([k, a]) => [k, { name: VENUES[k].name, taker: VENUES[k].taker, usd: r2(a.usd), coin: Object.fromEntries(COINS.map((c) => [c, r8(a.coin[c] || 0)])) }])),
      trade: { venue: VENUES[CFG.exec].name, usd: r2(st.trade.usd), coin: Object.fromEntries(COINS.map((c) => [c, r8(st.trade.coin[c] || 0)])) },
      perps: Object.values((st.tok && st.tok.pos) || {}).filter((p) => p && p.perp).map((p) => { const qq = st.tok.q[p.c] || {}, m = qq.mid || p.entry; return { c: p.c, tok: true, side: p.side, qty: r8(p.qty), entry: r2(p.entry), stop: r2(p.stop), lev: p.lev, margin: r2(p.margin), px: r2(m), pnl: r2(p.side * p.qty * (m - p.entry) - p.fee - (p.fund || 0)), t0: p.t0, why: p.why }; }).concat(Object.values(st.pos.trend || {}).filter((p) => p && p.perp).map((p) => ({ c: p.c, side: p.side, qty: r8(p.qty), entry: r2(p.entry), stop: r2(p.stop), lev: p.lev, margin: r2(p.margin), px: r2(st.last[p.c] || p.entry), pnl: r2(p.side * p.qty * ((st.last[p.c] || p.entry) - p.entry) - p.fee - (p.fund || 0)), t0: p.t0, why: p.why }))),
      pos: st.pos, w: st.w, tilt: st.tilt || null, brake: st.brake, spreads: st.spreads, mkt,
      toks: Object.keys((st.tok && st.tok.hold) || {}).map((k) => { const T = st.tok, qq = T.q[k] || {}, p = T.pos[k] || null; return { s: k, name: TOKS[k] || k, qty: r8(T.hold[k]), bid: qq.bid || null, ask: qq.ask || null, value: r2(T.hold[k] * (qq.mid || 0)), entry: p ? r2(p.entry) : null, stop: p ? r2(p.stop) : null, t0: p ? p.t0 : null, pnl: p ? r2(T.hold[k] * ((qq.bid || 0) - p.entry) - p.fee) : null, why: p ? p.why : null }; }),
      tokQ: Object.fromEntries(Object.entries((st.tok && st.tok.q) || {}).map(([k, v]) => [k, { bid: v.bid, ask: v.ask }])),
      stake: (() => { const S = st.stake || { rates: {}, earned: {} }, net = {};
        for (const c of CFG.stake.coins) net[c] = Math.round((isNum(S.rates[c]) ? S.rates[c] : CFG.stake.fallback[c]) * (1 - CFG.stake.cut) * 1e4) / 1e4;
        if (isNum(S.rates.USD)) net.USD = Math.round(S.rates.USD * 1e4) / 1e4;
        return { net, gross: S.rates, cut: CFG.stake.cut, src: S.src || null, earned: Object.fromEntries(Object.entries(S.earned).map(([k, v]) => [k, k === 'USD' ? r2(v) : r8(v)])) }; })(),
      stats: Object.fromEntries(Object.entries(st.stats).map(([k, v]) => [k, { n: v.n, pnl: r2(v.pnl || 0), fees: r2(v.fees || 0) }])),
      fills: st.fills.slice(-80).reverse(), log: st.log.slice(-30).reverse(), eqMin: st.eqMin.slice(-1440), eqHour: st.eqHour.slice(-720), transfers: st.transfers,
      cfg: { coins: COINS, exec: CFG.exec, arbShare: CFG.arbShare, arbMinEdge: CFG.arbMinEdge, scalp: CFG.scalp, trend: CFG.trend, brakes: CFG.brakes },
    };
  }

  // hourly or minute bars from an exchange's candles ([[t ms, o, h, l, c], ...]), so the strategies need not wait
  function seed(st, c, kind, candles) {
    const list = (st.bars[kind][c] = st.bars[kind][c] || []), keep = kind === 'h' ? CFG.keepBarsH : CFG.keepBarsM;
    const have = new Set(list.map((b) => b.t));
    for (const [t, o, h, l, cl] of candles) if (!have.has(t) && [o, h, l, cl].every(isNum)) list.push({ t, o, h, l, c: cl });
    list.sort((a, b) => a.t - b.t);
    if (list.length > keep) list.splice(0, list.length - keep);
  }

  // hourly bars for a token from Kraken's candles
  function seedTok(st, k, candles) {
    const T = tokState(st), list = (T.bars[k] = T.bars[k] || []), have = new Set(list.map((b) => b.t));
    for (const [t, o, h, l, cl] of candles) if (!have.has(t) && [o, h, l, cl].every(isNum)) list.push({ t, o, h, l, c: cl });
    list.sort((a, b) => a.t - b.t);
    if (list.length > CFG.keepBarsH) list.splice(0, list.length - CFG.keepBarsH);
  }
  const api = { COINS, TOKS, TOK_FEE, VENUES, CFG, WD_FEE, init, fund, freeUsd, step, view, mids, equity, seed, seedTok };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperCrypto = api;
})(typeof self !== 'undefined' ? self : this);
