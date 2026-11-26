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
    // the owner (2026-11-25): shorts take their profit quickly, longs ride it (trend and tokens). A short is bought back at
    // +shortTakeR R (R: entry to the first stop) on any poll; once +1R its stop trails shortTrailK ATR above the low and it
    // leaves on a shortExitH-hour high. A long that has made +longFromR R leaves on a longExitH-hour low (not 10), and from
    // +longHoldFromR R its stop trails longTrailK ATR below the high (not 3)
    asymC: { shortTakeR: 1.5, shortTrailK: 1.5, shortExitH: 5, longFromR: 1, longExitH: 20, longHoldFromR: 2, longTrailK: 4 },
    // mean reversion, hourly (owner 2026-11-26: the quant families, computed): while the coin ranges (Kaufman efficiency
    // ratio of the last 24 hours below erMax: net move over path length), a close zIn standard deviations from its
    // 20-hour mean is bought (below) or sold short (above, perpetual); out at the mean, at zStop deviations, or after
    // maxH hours; never against the trend or scalp position in the same coin
    mr: { look: 20, erLook: 24, erMax: 0.3, zIn: 2, zStop: 3.5, maxH: 12, risk: 0.004, maxW: 0.1 },
    // market making on the trading venue (Binance.US spot: 0% maker, 0.02% taker on every pair since 2026-04): a bid and
    // an ask around a reservation price that leans against the inventory (Avellaneda–Stoikov: r = mid × (1 − skew ×
    // q/qMax × half)), the half-spread k × the last hour's 1-minute volatility over the 15-second poll (at least minHalf);
    // long-only inventory (spot) up to maxLots lots of lotW × the account; a quote fills only when the market trades
    // through it by the next poll (conservative: no queue, no partial fills); the inventory is sold with a taker order
    // once older than maxHoldMin or down stopPct. R per round trip: profit over unitRisk × the lot's cost
    mm: { lotW: 0.005, maxLots: 4, k: 1.5, minHalf: 0.0003, skew: 1, maxHoldMin: 60, stopPct: 0.01, makerFee: 0, thru: 0.0001, keepFills: 40 },
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
    // scalp rules tried side by side on the same prices as shadows (no money; fills at the bid/ask with the exchange fee
    // and slippage): the live scalp uses the best of the last 7 days once it has 30 trades and earns at least +0.05R a
    // trade after costs; when none does, no new live scalps (owner's request 2026-11-25: every scalp trade is a sample
    // and the AI improves the rule). The old rule (brk) starts with the live record: 451 trades, −0.20R, 2026-11-18~25
    scalpV: {
      brk: { name: '15분 고점 돌파 매수(기존)', both: false, mode: 'brk', mom: 0.003, tp: 0.005, sl: 0.0035, maxMin: 20 },
      brk2: { name: '위아래 돌파·넓은 목표', both: true, mode: 'brk', mom: 0.004, tp: 0.012, sl: 0.008, maxMin: 60 },
      trd: { name: '추세 방향 돌파', both: true, mode: 'brk', trend: true, mom: 0.004, tp: 0.012, sl: 0.008, maxMin: 60 },
      fade: { name: '급등락 되돌림', both: true, mode: 'fade', mom: 0.006, tp: 0.008, sl: 0.008, maxMin: 30 },
      night: { name: '위아래 돌파·미국 장 밖', both: true, mode: 'brk', offUS: true, mom: 0.004, tp: 0.012, sl: 0.008, maxMin: 60 },
    },
    scalpPick: { days: 7, minN: 30, minR: 0.05, everyMs: 3600e3, keep: 4000 },
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
  // the rest of the account's direction in each underlying (+1 long, −1 short) from the stock and derivatives books
  // (tools/run.mjs → data/dirs.json): a token is never held against it (the owner: no long and short of the same thing)
  let EXT = { dirs: {} };
  function setExt(x) { EXT = Object.assign({ dirs: {} }, x || {}); }

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
    for (const s of ['trend', 'scalp', 'mr']) for (const c in (st.pos && st.pos[s]) || {}) { const p = st.pos[s][c]; if (p && p.perp) v += p.margin + p.side * p.qty * (px(c) - p.entry); }
    return v;
  }
  const tokState = (st) => (st.tok = st.tok || { hold: {}, pos: {}, bars: {}, q: {} });
  // each strategy's totals since the account last started (a reset starts them again; the trades stay in the records)
  function STATS0() { return { arb: { n: 0, pnl: 0, fees: 0 }, trend: { n: 0, pnl: 0, fees: 0 }, scalp: { n: 0, pnl: 0, fees: 0 }, tok: { n: 0, pnl: 0, fees: 0 }, mr: { n: 0, pnl: 0, fees: 0 }, mm: { n: 0, pnl: 0, fees: 0 }, basis: { n: 0, pnl: 0, fees: 0 }, moves: { n: 0, fees: 0 } }; }
  function fill(st, f) { st.fills.push(f); if (st.fills.length > CFG.keepFills) st.fills.splice(0, st.fills.length - CFG.keepFills); }
  function closeRow(st, row) {
    (st.closed = st.closed || []).push(row);
    if (st.closed.length > 500) st.closed.splice(0, st.closed.length - 500);
    if (typeof st.onClose === 'function') st.onClose(row);
  }
  // which strategies may open new trades: st.only (a strategy check runs one alone) and st.allow (the verified list from
  // data/verify.json, owner 2026-11-26: only what a backtest has proved trades); exits always run
  const allowOf = (st) => (Array.isArray(st.allow) ? st.allow : Array.isArray(EXT.allow) ? EXT.allow : null);
  const may = (st, s) => { const A = allowOf(st); return (!st.only || st.only === s) && (!A || A.some((x) => x === s || x.startsWith(s + ':'))); };
  // the scalp rule that trades: the verified one (st.allow 'scalp:<rule>'); with no list (the old way) the shadows pick
  const scalpLive = (st) => { const A = allowOf(st); if (!A) return st.sv && st.sv.live; const x = A.find((y) => y.startsWith('scalp:')); return x ? x.slice(6) : null; };

  // a new account: part of the money spread over the exchanges for arbitrage (half dollars, half coins), the rest in
  // dollars at the trading exchange for the trend and scalp strategies
  function init(capital, q, now) {
    const m = mids(q), venues = {};
    for (const k in VENUES) venues[k] = { usd: 0, coin: Object.fromEntries(COINS.map((c) => [c, 0])) };
    const st = { v: 1, start: now, funded: 0, venues, trade: { usd: 0, coin: Object.fromEntries(COINS.map((c) => [c, 0])) }, pos: { trend: {}, scalp: {} }, bars: { h: {}, m: {} }, fills: [], eqMin: [], eqHour: [], closes: {},
      w: { trend: CFG.trialW, scalp: CFG.trialW, mr: CFG.trialW, mm: CFG.trialW }, lastReweight: now, peak: 0, day: { date: utcDay(now), eq: 0 }, last: {}, spreads: {}, transfers: [], stats: STATS0(), log: [],
      tok: { hold: {}, pos: {}, bars: {}, q: {} } };
    for (const c of COINS) st.last[c] = m[c];
    if (capital > 0) fund(st, capital, q, now, 'start');
    return st;
  }
  // the owner's account reset: every position is closed at the current quotes (recorded like any exit), then the account
  // starts again with no money; the records (fills, closed trades, statistics, price bars) and the transfers already
  // seen are kept, so the allocator's next transfer funds it once
  function reset(st, q, now, id) {
    const m = mids(q), eq0 = equity(st, m);
    for (const s of ['trend', 'scalp', 'mr']) for (const c of Object.keys(st.pos[s] || {})) {
      const p = st.pos[s][c], b = (q.books[CFG.exec] || {})[c] || Object.values(q.books).map((v) => v && v[c]).find((x) => x && x.bid > 0); if (!p || !b) continue;
      if (p.perp) perpClose(st, s, c, p.side > 0 ? b.bid : b.ask, now, '계좌 초기화 정리'); else sell(st, s, c, b.bid, now, '계좌 초기화 정리');
    }
    if (st.tok) for (const k of Object.keys(st.tok.pos || {})) { const x = st.tok.q[k]; if (x && x.bid > 0) tokSell(st, k, st.tok.pos[k].side < 0 ? x.ask : x.bid, now, '계좌 초기화 정리'); }
    const fresh = init(0, q, now);
    fresh.w = { trend: 1, scalp: 1, mr: 1, mm: 1 };
    for (const k of ['fills', 'closed', 'bars', 'transfers', 'stake', 'sv']) if (st[k] != null) fresh[k] = st[k];
    fresh.statsFor = id;
    if (st.tok) { fresh.tok.bars = st.tok.bars || {}; fresh.tok.q = st.tok.q || {}; }
    fresh.resetId = id;
    (fresh.resets = st.resets || []).push({ id, t: now, eqBefore: r2(eq0) });
    return fresh;
  }
  // money in (or out) from the main account; arbitrage inventory is topped up to its share, the rest goes to trading cash
  function fund(st, amount, q, now, id) {
    const m = mids(q), ks = Object.keys(VENUES);
    st.funded += amount;
    if (amount > 0) {
      const arb = amount * (may(st, 'arb') ? CFG.arbShare : 0), rest = amount - arb, per = arb / ks.length;
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
    closeRow(st, { t: now, s, c, pnl: r2(pnl), R: Math.round(R * 100) / 100, side: p.side });
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
    closeRow(st, { t: now, s, c, pnl: r2(pnl), R: Math.round(R * 100) / 100 });
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
  // ── scalp rules as shadows
  const SV = (st) => (st.sv = st.sv || { pos: {}, done: [], live: 'brk', at: 0, seeded: false });
  // a scalp rule's signal on the last closed minute bar: +1 buy, −1 short, 0 nothing
  function scalpSig(V, done, hb, now) {
    const L = CFG.scalp.look;
    if (done.length < L + 6) return 0;
    const last = done[done.length - 1], prev = done.slice(-L - 1, -1), c5 = done[done.length - 6];
    const hi = Math.max(...prev.map((b) => b.h)), lo = Math.min(...prev.map((b) => b.l)), mv = last.c / c5.c - 1;
    let s = 0;
    if (V.mode === 'brk') s = last.c > hi && mv > V.mom ? 1 : V.both && last.c < lo && mv < -V.mom ? -1 : 0;
    else if (V.mode === 'fade') s = last.c > hi && mv > V.mom ? -1 : last.c < lo && mv < -V.mom ? 1 : 0;
    if (s && V.offUS && usOpen(now)) s = 0;
    if (s && V.trend) {
      const hd = (hb || []).slice(0, -1);
      if (hd.length <= CFG.trend.ema) return 0;
      const e = ema(hd.map((b) => b.c), CFG.trend.ema), lc = hd[hd.length - 1].c;
      if ((s > 0 && !(lc > e)) || (s < 0 && !(lc < e))) s = 0;
    }
    return s;
  }
  // every rule's paper trades on this coin: exits on every poll, entries on a closed minute bar
  function scalpShadows(st, c, B, mb, hb, mClosed, now) {
    const S = SV(st), f = VENUES[CFG.exec].taker;
    for (const k of Object.keys(CFG.scalpV)) {
      const V = CFG.scalpV[k], P = (S.pos[k] = S.pos[k] || {}), p = P[c];
      if (!p) continue;
      const px = p.side > 0 ? B.bid * (1 - CFG.slip) : B.ask * (1 + CFG.slip), g = p.side * (px / p.entry - 1);
      if (g >= V.tp || g <= -V.sl || now - p.t0 >= V.maxMin * 60e3) { S.done.push({ t: now, v: k, c, side: p.side, R: Math.round(((g - 2 * f) / V.sl) * 100) / 100 }); delete P[c]; }
    }
    if (mClosed && mb.length > CFG.scalp.look + 7) {
      const done = mb.slice(0, -1);
      for (const k of Object.keys(CFG.scalpV)) {
        const P = (S.pos[k] = S.pos[k] || {});
        if (P[c]) continue;
        const sg = scalpSig(CFG.scalpV[k], done, hb, now);
        if (sg) P[c] = { side: sg, entry: sg > 0 ? B.ask * (1 + CFG.slip) : B.bid * (1 - CFG.slip), t0: now };
      }
    }
    if (S.done.length > CFG.scalpPick.keep) S.done.splice(0, S.done.length - CFG.scalpPick.keep);
  }
  function scalpScores(st, now) {
    const S = SV(st), out = {};
    for (const k of Object.keys(CFG.scalpV)) out[k] = { n: 0, R: 0, sum: 0 };
    for (const x of S.done) if (out[x.v] && now - x.t <= CFG.scalpPick.days * 864e5) { out[x.v].n++; out[x.v].sum += x.R; }
    for (const k in out) { out[k].R = out[k].n ? Math.round((out[k].sum / out[k].n) * 1000) / 1000 : 0; delete out[k].sum; }
    return out;
  }
  // once an hour: the live scalp follows the best rule of the last 7 days (none good enough: no new live scalps)
  function scalpPick(st, now) {
    const S = SV(st), K = CFG.scalpPick;
    if (!S.seeded) { for (const x of st.closed || []) if (x.s === 'scalp') S.done.push({ t: x.t, v: 'brk', c: x.c, side: 1, R: x.R, live: 1 }); S.done.sort((a, b) => a.t - b.t); S.seeded = true; }
    if (now - (S.at || 0) < K.everyMs) return;
    S.at = now;
    const sc = scalpScores(st, now), ok = Object.keys(sc).filter((k) => sc[k].n >= K.minN && sc[k].R >= K.minR).sort((a, b) => sc[b].R - sc[a].R), best = ok[0] || null;
    if (best === S.live) return;
    const was = S.live && sc[S.live] ? `${CFG.scalpV[S.live].name} ${sc[S.live].n}건 평균 ${sc[S.live].R.toFixed(2)}R` : '없음';
    st.log.push({ t: now, kind: 'weight', text: best ? `초단타 규칙을 '${CFG.scalpV[best].name}'(으)로 바꿉니다: 최근 ${K.days}일 그림자 ${sc[best].n}건, 수수료를 뺀 평균 ${sc[best].R.toFixed(2)}R (전: ${was})`
      : `초단타 새 매매를 멈춥니다: 최근 ${K.days}일 수수료를 뺀 평균이 +${K.minR}R 이상이고 ${K.minN}건 넘게 쌓인 규칙이 없습니다 (전: ${was}). 규칙 ${Object.keys(CFG.scalpV).length}개를 그림자로 계속 시험합니다` });
    S.live = best;
  }
  // ── mean reversion, hourly (CFG.mr): exits on every poll (the mean reached, the stop, the clock), entries on a closed
  // hourly bar while the coin ranges
  function meanRev(st, c, B, hb, hClosed, now, eq, stopNew, half) {
    const K = CFG.mr, P = (st.pos.mr = st.pos.mr || {}), p = P[c];
    if (p) {
      const px = p.side < 0 ? B.ask : B.bid, sd = p.side < 0 ? -1 : 1;
      if (sd > 0 ? px >= p.tgt : px <= p.tgt) return exitPos(st, 'mr', c, B, now, '평균 복귀(목표)');
      if (sd > 0 ? px <= p.stop : px >= p.stop) return exitPos(st, 'mr', c, B, now, `손절(평균에서 ${K.zStop} 표준편차)`);
      if (now - p.t0 >= K.maxH * 3600e3) return exitPos(st, 'mr', c, B, now, `시간 청산(${K.maxH}시간)`);
    }
    if (!hClosed || hb.length < Math.max(K.look, K.erLook) + 3) return;
    const cl = hb.slice(0, -1).map((b) => b.c), last = cl[cl.length - 1], w = cl.slice(-K.look);
    const mean = w.reduce((a, b) => a + b, 0) / w.length, sdv = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1));
    if (p) { p.tgt = mean; return; }                       // the target follows the mean, the stop stays
    if (stopNew || !may(st, 'mr') || !(sdv > 0)) return;
    const seg = cl.slice(-K.erLook - 1), path = seg.slice(1).reduce((a, v, i) => a + Math.abs(v - seg[i]), 0);
    const er = path > 0 ? Math.abs(seg[seg.length - 1] - seg[0]) / path : 1, z = (last - mean) / sdv;
    const side = er < K.erMax ? (z <= -K.zIn ? 1 : z >= K.zIn ? -1 : 0) : 0;
    if (!side) return;
    const dirOf = (q2) => (q2 ? (q2.perp ? q2.side : 1) : 0), tD = dirOf(st.pos.trend[c]), sD = dirOf(st.pos.scalp[c]);
    if ((tD && tD !== side) || (sD && sD !== side)) return;   // never against another position in this coin
    const px = side > 0 ? B.ask : B.bid, stop = mean - side * K.zStop * sdv, per = Math.abs(px - stop);
    if (!(per > 0) || (side > 0 ? stop >= px : stop <= px)) return;
    const risk = eq * K.risk * (st.w.mr != null ? st.w.mr : CFG.trialW) * tiltOf(st, 'mr') * half;
    const qty = f8(Math.min(risk / per, (K.maxW * eq) / px, side > 0 ? st.trade.usd / (px * 1.01) : (st.trade.usd * CFG.perp.lev) / (px * 1.02)));
    if (qty * px < 20) return;
    const why = `평균회귀: 20시간 평균 ${r2(mean)}에서 ${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)} 표준편차, 24시간 효율비 ${er.toFixed(2)}(${K.erMax} 미만: 횡보) → ${side > 0 ? '매수' : '공매도'}, 목표 평균, 손절 ${r2(stop)}`;
    const ex = { stop, stop0: stop, tgt: mean, risk: qty * per };
    if (side > 0) buy(st, 'mr', c, qty, px, now, why, ex); else perpOpen(st, 'mr', c, -1, qty, px, now, why, ex);
  }
  // ── the bitcoin basis's spot leg: hold what the derivatives part sold in CME futures (EXT.basis.qty bitcoin), bought
  // or sold at the trading exchange with a taker order when the target changes; never used by the other strategies
  function basisLeg(st, B, now) {
    const want = EXT.basis && isNum(EXT.basis.qty) ? Math.max(0, EXT.basis.qty) : null, S = (st.basis = st.basis || { qty: 0, cost: 0, t0: 0 }), v = st.trade;
    if (want == null || !B || !(B.bid > 0)) return;
    const diff = f8(want - S.qty), f = VENUES[CFG.exec].taker;
    if (Math.abs(diff) * B.bid < 10) return;
    if (diff > 0) {
      const px = B.ask * (1 + CFG.slip), q = f8(Math.min(diff, Math.max(0, v.usd) / (px * (1 + f))));
      if (q * px < 10) { if (st.basisWarn !== utcDay(now)) { st.basisWarn = utcDay(now); st.log.push({ t: now, kind: 'warn', text: `베이시스 현물 매수에 쓸 달러가 부족합니다(필요 ${r2(diff * px)}달러)` }); } return; }
      v.usd -= q * px * (1 + f); v.coin.BTC = (v.coin.BTC || 0) + q; S.cost = (S.cost * S.qty + q * px) / (S.qty + q); if (!S.qty) S.t0 = now; S.qty = f8(S.qty + q);
      fill(st, { t: now, s: 'basis', c: 'BTC', side: 'buy', qty: r8(q), px: r2(px), fee: r2(q * px * f), why: `비트코인 현·선물 차익: CME 선물 매도분만큼 현물 보유(목표 ${r8(want)} BTC)${EXT.basis.why ? ' · ' + EXT.basis.why : ''}` });
    } else {
      const px = B.bid * (1 - CFG.slip), q = f8(Math.min(-diff, S.qty, Math.max(0, v.coin.BTC || 0))), pnl = (px - S.cost) * q - q * px * f;
      if (!(q > 0)) return;
      v.usd += q * px * (1 - f); v.coin.BTC -= q; S.qty = f8(S.qty - q); if (S.qty <= 1e-10) { S.qty = 0; S.cost = 0; S.t0 = 0; }
      st.stats.basis = st.stats.basis || { n: 0, pnl: 0, fees: 0 }; st.stats.basis.n++; st.stats.basis.pnl += pnl; st.stats.basis.fees += q * px * f;
      fill(st, { t: now, s: 'basis', c: 'BTC', side: 'sell', qty: r8(q), px: r2(px), fee: r2(q * px * f), pnl: r2(pnl), why: `비트코인 현·선물 차익: 선물 매도분이 줄어 현물도 정리(목표 ${r8(want)} BTC). 현물 쪽 손익은 선물 쪽과 맞물립니다` });
    }
  }
  // ── market making (CFG.mm), every poll: the last quotes' fills, the inventory's limits, then new quotes.
  // A quote counts as filled only when a trade at the trading exchange printed through it (K.thru past the price, so the
  // place in the queue does not matter) between the quote and this poll, or this poll's book already crosses it. Each
  // fill is kept in its own short list (st.mmFills), and each coin's day goes to the closed list as one row, so the
  // hundreds of small fills never crowd out the other strategies' trades or their 7-day scores.
  function mmUnit(st, eq) { return eq * CFG.mr.risk * (st.w.mm != null ? st.w.mm : CFG.trialW) * tiltOf(st, 'mm'); }
  function mmRoll(st, c, s, now, eq) {                       // a new UTC day: yesterday's book becomes one closed row
    const d = utcDay(now), D = s.day;
    if (D && D.d !== d && D.n > 0) {
      closeRow(st, { t: now, s: 'mm', c, pnl: r2(D.pnl), R: Math.round((D.pnl / Math.max(1e-9, D.u)) * 100) / 100, n: D.n, day: D.d });
    }
    if (!D || D.d !== d) s.day = { d, n: 0, pnl: 0, u: mmUnit(st, eq) };
    else s.day.u = Math.max(s.day.u || 0, mmUnit(st, eq));
    return s.day;
  }
  function marketMake(st, c, B, mb, now, eq, stopNew, T) {
    const K = CFG.mm, M = (st.mm = st.mm || {}), s = (M[c] = M[c] || { q: 0, cost: 0, t0: 0, bid: null, ask: null, n: 0, pnl: 0, vol: 0 }), v = st.trade;
    const mid = (B.bid + B.ask) / 2, fee = K.makerFee, stS = (st.stats.mm = st.stats.mm || { n: 0, pnl: 0, fees: 0 }), D = mmRoll(st, c, s, now, eq);
    const rec = (f) => { const L = (st.mmFills = st.mmFills || []); L.push(f); if (L.length > K.keepFills) L.splice(0, L.length - K.keepFills); };
    const sell = (q0, px, f, why) => {                       // inventory sold: the profit goes to the day's row and the totals
      const q = Math.min(q0, s.q, Math.max(0, v.coin[c] || 0));
      if (!(q > 0)) { s.q = 0; s.cost = 0; s.t0 = 0; return; }
      const pnl = (px - s.cost) * q - q * px * f;
      v.usd += q * px * (1 - f); v.coin[c] = (v.coin[c] || 0) - q;
      stS.n++; stS.pnl += pnl; stS.fees += q * px * f; s.pnl += pnl; s.n++; s.vol += q * px; D.n++; D.pnl += pnl;
      rec({ t: now, c, side: 'sell', qty: r8(q), px: r2(px), pnl: r2(pnl), why, held: s.t0 ? Math.round((now - s.t0) / 60e3) : 0 });
      s.q = f8(s.q - q);
      if (s.q <= 1e-10) { s.q = 0; s.cost = 0; s.t0 = 0; }
    };
    // 1) fills: the lowest and highest trade since the quotes (or this poll's book) went through them
    const tp = T && T.n > 0 && now - (T.from || 0) < 3600e3 ? T : null;
    const lo = Math.min(B.ask, tp ? tp.lo : Infinity), hi = Math.max(B.bid, tp ? tp.hi : -Infinity);
    s.src = tp ? 'trades' : 'book';
    if (s.bid && lo < s.bid.px * (1 - K.thru) && v.usd >= s.bid.q * s.bid.px * (1 + fee)) {
      const q = s.bid.q, px = s.bid.px;
      v.usd -= q * px * (1 + fee); v.coin[c] = (v.coin[c] || 0) + q;
      s.cost = (s.cost * s.q + px * q) / (s.q + q); if (!s.q) s.t0 = now; s.q = f8(s.q + q); s.n++; s.vol += q * px;
      rec({ t: now, c, side: 'buy', qty: r8(q), px: r2(px), why: `매수 호가 ${r2(px)} 체결: ${tp ? `그 사이 체결가가 ${r2(tp.lo)}까지` : `호가창 매도 최저가가 ${r2(B.ask)}로`} 내려와 호가를 뚫음` });
    }
    if (s.ask && s.q > 0 && hi > s.ask.px * (1 + K.thru)) sell(s.ask.q, s.ask.px, fee, `매도 호가 ${r2(s.ask.px)} 체결: ${tp ? `그 사이 체결가가 ${r2(tp.hi)}까지` : `호가창 매수 최고가가 ${r2(B.bid)}로`} 올라와 호가를 뚫음`);
    s.bid = s.ask = null;
    // 2) the inventory's limits: too old, or down stopPct → sold at the bid with a taker order
    if (s.q > 0) {
      const old = now - s.t0 >= K.maxHoldMin * 60e3, hurt = B.bid <= s.cost * (1 - K.stopPct);
      if (old || hurt) sell(s.q, B.bid * (1 - CFG.slip), VENUES[CFG.exec].taker, old ? `재고 정리: ${K.maxHoldMin}분 넘게 보유` : `재고 손절: 평균 단가보다 ${K.stopPct * 100}% 넘게 하락`);
    }
    if (stopNew || !may(st, 'mm')) return;
    // 3) new quotes (Avellaneda–Stoikov in spirit): a half-spread from the last hour's 1-minute volatility over the
    //    15-second poll, the center leaning against the inventory; a bid only while there is room, cash, and no short
    //    trend or mean-reversion short in this coin; an ask only to sell inventory
    const mc = mb.slice(-61).map((b) => b.c);
    let sig = 0;
    if (mc.length >= 10) { const lr = mc.slice(1).map((x, i) => Math.log(x / mc[i])), mu = lr.reduce((a, b) => a + b, 0) / lr.length; sig = Math.sqrt(lr.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, lr.length - 1)); }
    const half = Math.max(K.minHalf, K.k * sig * Math.sqrt(0.25)), lotQ = f8((eq * K.lotW * ((st.w.mm != null ? st.w.mm : CFG.trialW) / CFG.trialW) * tiltOf(st, 'mm')) / mid);
    const qMax = K.maxLots * lotQ, r = mid * (1 - K.skew * (qMax > 0 ? Math.min(1, s.q / qMax) : 0) * half);
    const dirOf = (p) => (p ? (p.perp ? p.side : 1) : 0), against = dirOf(st.pos.trend[c]) < 0 || dirOf((st.pos.mr || {})[c]) < 0;
    const bidPx = Math.min(r * (1 - half), B.ask * (1 - 1e-6)), askPx = Math.max(r * (1 + half), B.bid * (1 + 1e-6));
    if (lotQ > 0 && s.q + lotQ <= qMax + 1e-12 && !against && v.usd > lotQ * bidPx * 1.01) s.bid = { px: bidPx, q: lotQ, at: now };
    if (s.q > 0) s.ask = { px: askPx, q: Math.min(lotQ || s.q, s.q), at: now };
    s.half = half; s.mid = mid; s.qMax = qMax;
  }
  function step(st, q, now) {
    // an account reset before the totals were kept per reset (2026-11-26): its totals start from zero once
    if (st.resetId && st.statsFor !== st.resetId) { st.stats = STATS0(); st.statsFor = st.resetId; }
    for (const [k, v] of Object.entries(STATS0())) st.stats[k] = st.stats[k] || v;
    const m = mids(q);
    for (const c of COINS) if (isNum(m[c])) st.last[c] = m[c];
    stake(st, now, m);
    if (!allowOf(st)) scalpPick(st, now);   // the old way: the shadows' best rule trades; with the verified list, no ranking
    if (may(st, 'arb')) arb(st, q, now);
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
        const tp = sp.tp || CFG.scalp.tp, sl = sp.sl || CFG.scalp.sl, mx = sp.maxMin || CFG.scalp.maxMin, short = sp.perp && sp.side < 0;
        const g = short ? 1 - B.ask / sp.entry : B.bid / sp.entry - 1;
        if (g >= tp) exitPos(st, 'scalp', c, B, now, '목표가');
        else if (g <= -sl) exitPos(st, 'scalp', c, B, now, '손절');
        else if (now - sp.t0 >= mx * 60e3) exitPos(st, 'scalp', c, B, now, '시간 청산');
      }
      // funding on every perpetual (trend, scalp, mean reversion), every poll: the real hourly rate when known
      // (EXT.fund, Hyperliquid's: longs pay it and shorts receive it when it is positive), else CFG.perp.fund a year as a
      // cost either way
      for (const s of ['trend', 'scalp', 'mr']) {
        const pp = st.pos[s] && st.pos[s][c];
        if (!pp || !pp.perp) continue;
        const yrs = Math.max(0, now - (pp.fAt || pp.t0)) / (365 * 864e5);
        if (yrs > 0 && yrs < 2 / 365) {
          const yr = EXT.fund && isNum(EXT.fund[c]) ? pp.side * EXT.fund[c] * 24 * 365 : CFG.perp.fund;
          const cost = pp.qty * m[c] * yr * yrs; st.trade.usd -= cost; pp.fund = (pp.fund || 0) + cost; (st.stats[s] = st.stats[s] || { n: 0, pnl: 0, fees: 0 }).fees += cost;
        }
        pp.fAt = now;
      }
      const tp = st.pos.trend[c];
      if (tp && tp.perp && -tp.side * tp.qty * ((tp.side > 0 ? B.bid : B.ask) - tp.entry) >= CFG.perp.guard * tp.margin) exitPos(st, 'trend', c, B, now, '증거금 80% 손실: 강제 청산 전 정리');
      else if (tp && (tp.side < 0 ? B.ask >= tp.stop : B.bid <= tp.stop)) exitPos(st, 'trend', c, B, now, (tp.side < 0 ? tp.stop < tp.stop0 : tp.stop > tp.stop0) ? '추적 손절' : '손절');
      else if (tp && tp.side < 0 && Math.abs(tp.stop0 - tp.entry) > 0 && tp.entry - B.ask >= CFG.asymC.shortTakeR * Math.abs(tp.stop0 - tp.entry)) exitPos(st, 'trend', c, B, now, `공매도 익절(+${CFG.asymC.shortTakeR}R)`);
      // trend: signals on a closed hourly bar
      if (hClosed && hb.length > CFG.trend.ema) {
        const done = hb.slice(0, -1), last = done[done.length - 1], prev = done.slice(-CFG.trend.hi - 1, -1);
        const a = atr(done, CFG.trend.atr), e = ema(done.map((b) => b.c), CFG.trend.ema);
        const p = st.pos.trend[c];
        if (p && p.side < 0) {                                   // a short: the stop trails down; out on a 10-hour high (5 once +1R)
          p.loC = Math.min(p.loC || Infinity, last.c);
          const A = CFG.asymC, R0 = Math.abs(p.stop0 - p.entry), won = R0 > 0 && p.entry - p.loC >= R0;
          p.stop = Math.min(p.stop, p.loC + (won ? A.shortTrailK : CFG.trend.stopK) * a);
          const nH = won ? A.shortExitH : CFG.trend.lo, hi = Math.max(...done.slice(-nH - 1, -1).map((b) => b.h));
          if (last.c > hi) exitPos(st, 'trend', c, B, now, `${nH}시간 최고가 돌파${won ? '(이익 난 공매도는 빨리 정리)' : ''}`);
        } else if (p) {                                          // a long: out on a 10-hour low (20 once +1R), wider trail from +2R
          p.hiC = Math.max(p.hiC || 0, last.c);
          const A = CFG.asymC, R0 = Math.abs(p.entry - p.stop0), mR = R0 > 0 ? (p.hiC - p.entry) / R0 : 0;
          p.stop = Math.max(p.stop, p.hiC - (mR >= A.longHoldFromR ? A.longTrailK : CFG.trend.stopK) * a);
          const nL = mR >= A.longFromR ? A.longExitH : CFG.trend.lo, lo = Math.min(...done.slice(-nL - 1, -1).map((b) => b.l));
          if (last.c < lo) exitPos(st, 'trend', c, B, now, `${nL}시간 최저가 이탈${mR >= A.longFromR ? '(이익 난 매수는 길게)' : ''}`);
        } else if (!stopNew && may(st, 'trend') && a > 0 && ((last.c > Math.max(...prev.map((b) => b.h)) && last.c > e) || (last.c < Math.min(...prev.map((b) => b.l)) && last.c < e))) {
          // a new 20-hour high above the 100-hour average → long; a new 20-hour low below it → short (perpetual, up to
          // perp.lev × margin); size by risk to the stop, at most maxW × lev of the account in notional
          const side = last.c > e ? 1 : -1, px = side > 0 ? B.ask : B.bid;
          const sp2 = st.pos.scalp[c], spDir = sp2 ? (sp2.perp ? sp2.side : 1) : 0;
          if (spDir && spDir !== side) exitPos(st, 'scalp', c, B, now, '추세 매매와 반대 방향이라 정리(같은 코인 양방향 금지)');
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
      // scalp rules as shadows (a fault there never stops the account)
      try { scalpShadows(st, c, B, mb, hb, mClosed, now); } catch (e) { /* shadows only */ }
      // scalp: the rule the shadows picked (none: no new scalps), on a closed minute bar; never against the trend
      // position in the same coin. Buys are spot, shorts perpetual (up to perp.lev × margin)
      const LV = scalpLive(st) ? CFG.scalpV[scalpLive(st)] : null;
      if (LV && may(st, 'scalp') && mClosed && mb.length > CFG.scalp.look + 7 && !st.pos.scalp[c] && !stopNew) {
        const sg = scalpSig(LV, mb.slice(0, -1), hb, now), tp0 = st.pos.trend[c], tDir = tp0 ? (tp0.perp ? tp0.side : 1) : 0;
        if (sg && !(tDir && tDir !== sg)) {
          const px = sg > 0 ? B.ask : B.bid, per = px * LV.sl;
          const risk = eq * CFG.scalp.risk * st.w.scalp * tiltOf(st, 'scalp') * half;
          let qty = Math.min(risk / per, (CFG.scalp.maxW * eq) / px, sg > 0 ? st.trade.usd / (px * 1.01) : (st.trade.usd * CFG.perp.lev) / (px * 1.02));
          qty = f8(qty);
          const why = `${LV.name}: ${sg > 0 ? '매수' : '공매도'}, 목표 ${(LV.tp * 100).toFixed(1)}%·손절 ${(LV.sl * 100).toFixed(2)}%·최대 ${LV.maxMin}분`;
          const ex = { risk: qty * per, rule: st.sv.live, tp: LV.tp, sl: LV.sl, maxMin: LV.maxMin };
          if (qty * px >= 20) { if (sg > 0) buy(st, 'scalp', c, qty, px, now, why, ex); else perpOpen(st, 'scalp', c, -1, qty, px, now, why, ex); }
        }
      }
      // mean reversion and market making (a fault there is logged once a day and never stops the account)
      for (const [nm, fn] of [['평균회귀', () => meanRev(st, c, B, hb, hClosed, now, eq, stopNew, half)], ['시장 조성', () => marketMake(st, c, B, mb, now, eq, stopNew, q.tape && q.tape[c])]]) {
        try { fn(); } catch (e) { const d = utcDay(now); if (st.errDay !== d + nm) { st.errDay = d + nm; st.log.push({ t: now, kind: 'warn', text: `${nm} 계산 오류(${c}): ${String(e && e.message).slice(0, 120)}` }); } }
      }
    }
    toks(st, q, now, eq, stopNew || !may(st, 'tok'), half);
    if (!st.only) basisLeg(st, ex && ex.BTC, now);
    // the AI re-weights trend and scalp by their last 7 days
    if (allowOf(st) && !st.only) st.w = { trend: 1, scalp: 1, mr: 1, mm: 1 };
    else if (now - st.lastReweight >= CFG.reweightMs) {
      st.lastReweight = now;
      const recent = (st.closed || []).filter((x) => now - x.t <= CFG.reviewMs);
      const sc = {};
      for (const s of ['trend', 'scalp', 'mr', 'mm']) { const xs = recent.filter((x) => x.s === s); sc[s] = { n: xs.length, R: xs.reduce((a, x) => a + x.R, 0) }; }
      const ranked = Object.keys(sc).filter((s) => sc[s].n >= CFG.minTrades).sort((a, b) => sc[b].R - sc[a].R);
      const w = { trend: CFG.trialW, scalp: CFG.trialW, mr: CFG.trialW, mm: CFG.trialW };
      ranked.forEach((s, j) => { const tier = CFG.tiers[Math.min(j, CFG.tiers.length - 1)]; w[s] = sc[s].R > 0 ? tier : Math.min(tier, CFG.loserW); });
      const SN = { trend: '추세', scalp: '초단타', mr: '평균회귀', mm: '시장 조성' };
      if (Object.keys(w).some((k) => w[k] !== (st.w[k] != null ? st.w[k] : CFG.trialW))) st.log.push({ t: now, kind: 'weight', text: `최근 7일 성과로 위험 배분을 바꿉니다: ${Object.keys(w).map((k) => `${SN[k]} ${Math.round((st.w[k] != null ? st.w[k] : CFG.trialW) * 100)}% → ${Math.round(w[k] * 100)}%`).join(', ')} (${Object.keys(sc).map((k) => `${SN[k]} ${sc[k].n}건 ${sc[k].R.toFixed(1).replace('-', '−')}R`).join(', ')})` });
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
      const p = T.pos[k], ad = EXT.dirs[k.replace(/x$/, '')] || 0;
      if (p && ad && p.side !== ad) { tokSell(st, k, p.side < 0 ? x.ask : x.bid, now, '주식·파생 계좌와 반대 방향이라 정리(같은 종목 양방향 금지)'); continue; }
      if (p && p.perp) {
        const yrs = Math.max(0, now - (p.fAt || p.t0)) / (365 * 864e5);
        if (yrs > 0 && yrs < 2 / 365) { const cost = p.qty * mid * CFG.perp.fund * yrs; st.trade.usd -= cost; p.fund = (p.fund || 0) + cost; st.stats.tok.fees += cost; }
        p.fAt = now;
        if (-p.side * p.qty * ((p.side > 0 ? x.bid : x.ask) - p.entry) >= CFG.perp.guard * p.margin) { tokSell(st, k, p.side > 0 ? x.bid : x.ask, now, '증거금 80% 손실: 강제 청산 전 정리'); continue; }
      }
      if (p && (p.side < 0 ? x.ask >= p.stop : x.bid <= p.stop)) tokSell(st, k, p.side < 0 ? x.ask : x.bid, now, (p.side < 0 ? p.stop < p.stop0 : p.stop > p.stop0) ? '추적 손절' : '손절');
      else if (p && p.side < 0 && Math.abs(p.stop0 - p.entry) > 0 && p.entry - x.ask >= CFG.asymC.shortTakeR * Math.abs(p.stop0 - p.entry)) tokSell(st, k, x.ask, now, `공매도 익절(+${CFG.asymC.shortTakeR}R)`);
      if (!closed || hb.length <= K.ema) continue;
      const done = hb.slice(0, -1), last = done[done.length - 1], prev = done.slice(-K.hi - 1, -1);
      const a = atr(done, K.atr), e = ema(done.map((b) => b.c), K.ema);
      const p2 = T.pos[k];
      if (p2 && p2.side < 0) {
        p2.loC = Math.min(p2.loC || Infinity, last.c);
        const A = CFG.asymC, R0 = Math.abs(p2.stop0 - p2.entry), won = R0 > 0 && p2.entry - p2.loC >= R0;
        p2.stop = Math.min(p2.stop, p2.loC + (won ? A.shortTrailK : K.stopK) * a);
        const nH = won ? A.shortExitH : K.lo, hi = Math.max(...done.slice(-nH - 1, -1).map((b) => b.h));
        if (last.c > hi) tokSell(st, k, x.ask, now, `${nH}시간 최고가 돌파${won ? '(이익 난 공매도는 빨리 정리)' : ''}`);
      } else if (p2) {
        p2.hiC = Math.max(p2.hiC || 0, last.c);
        const A = CFG.asymC, R0 = Math.abs(p2.entry - p2.stop0), mR = R0 > 0 ? (p2.hiC - p2.entry) / R0 : 0;
        p2.stop = Math.max(p2.stop, p2.hiC - (mR >= A.longHoldFromR ? A.longTrailK : K.stopK) * a);
        const nL = mR >= A.longFromR ? A.longExitH : K.lo, lo = Math.min(...done.slice(-nL - 1, -1).map((b) => b.l));
        if (last.c < lo) tokSell(st, k, x.bid, now, `${nL}시간 최저가 이탈${mR >= A.longFromR ? '(이익 난 매수는 길게)' : ''}`);
      } else {
        const off = !usOpen(now), sprMax = off ? K.offSpread : K.maxSpread;
        const longSig = last.c > Math.max(...prev.map((b) => b.h)) && last.c > e, shortSig = last.c < Math.min(...prev.map((b) => b.l)) && last.c < e;
        if (!stopNew && spr <= sprMax && a > 0 && (longSig || shortSig) && !(ad && ad !== (longSig ? 1 : -1))) {
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
    closeRow(st, { t: now, s: 'tok', c: k, pnl: r2(pnl), R: Math.round(R * 100) / 100 });
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
      basis: st.basis && st.basis.qty > 0 ? { qty: r8(st.basis.qty), cost: r2(st.basis.cost), since: st.basis.t0 } : null, mmFills: (st.mmFills || []).slice(-20), allow: allowOf(st),
      venues: Object.fromEntries(Object.entries(st.venues).map(([k, a]) => [k, { name: VENUES[k].name, taker: VENUES[k].taker, usd: r2(a.usd), coin: Object.fromEntries(COINS.map((c) => [c, r8(a.coin[c] || 0)])) }])),
      trade: { venue: VENUES[CFG.exec].name, usd: r2(st.trade.usd), coin: Object.fromEntries(COINS.map((c) => [c, r8(st.trade.coin[c] || 0)])) },
      perps: Object.values((st.tok && st.tok.pos) || {}).filter((p) => p && p.perp).map((p) => { const qq = st.tok.q[p.c] || {}, m = qq.mid || p.entry; return { c: p.c, tok: true, side: p.side, qty: r8(p.qty), entry: r2(p.entry), stop: r2(p.stop), lev: p.lev, margin: r2(p.margin), px: r2(m), pnl: r2(p.side * p.qty * (m - p.entry) - p.fee - (p.fund || 0)), t0: p.t0, why: p.why }; }).concat(Object.values(st.pos.trend || {}).filter((p) => p && p.perp).map((p) => ({ c: p.c, side: p.side, qty: r8(p.qty), entry: r2(p.entry), stop: r2(p.stop), lev: p.lev, margin: r2(p.margin), px: r2(st.last[p.c] || p.entry), pnl: r2(p.side * p.qty * ((st.last[p.c] || p.entry) - p.entry) - p.fee - (p.fund || 0)), t0: p.t0, why: p.why })))
        .concat(Object.values(st.pos.mr || {}).filter((p) => p && p.perp).map((p) => ({ c: p.c, s: 'mr', side: p.side, qty: r8(p.qty), entry: r2(p.entry), stop: r2(p.stop), lev: p.lev, margin: r2(p.margin), px: r2(st.last[p.c] || p.entry), pnl: r2(p.side * p.qty * ((st.last[p.c] || p.entry) - p.entry) - p.fee - (p.fund || 0)), t0: p.t0, why: p.why })))
        .concat(Object.values(st.pos.scalp || {}).filter((p) => p && p.perp).map((p) => ({ c: p.c, s: 'scalp', side: p.side, qty: r8(p.qty), entry: r2(p.entry), stop: r2(p.entry * (1 + p.side * -(p.sl || CFG.scalp.sl))), lev: p.lev, margin: r2(p.margin), px: r2(st.last[p.c] || p.entry), pnl: r2(p.side * p.qty * ((st.last[p.c] || p.entry) - p.entry) - p.fee - (p.fund || 0)), t0: p.t0, why: p.why }))),
      sv: (() => { const S = st.sv, now = st.at || Date.now(); if (!S) return null; const sc = scalpScores(st, now); return { live: S.live || null, pick: CFG.scalpPick, rules: Object.keys(CFG.scalpV).map((k) => ({ k, name: CFG.scalpV[k].name, n: sc[k].n, R: sc[k].R, tp: CFG.scalpV[k].tp, sl: CFG.scalpV[k].sl, maxMin: CFG.scalpV[k].maxMin })) }; })(),
      pos: st.pos, w: st.w, tilt: st.tilt || null, brake: st.brake, spreads: st.spreads, mkt,
      mm: st.mm ? { cfg: CFG.mm, coins: Object.fromEntries(Object.entries(st.mm).map(([c, x]) => [c, { q: r8(x.q), cost: r2(x.cost), mid: r2(x.mid || 0), half: x.half ? Math.round(x.half * 1e6) / 1e6 : null, bid: x.bid ? r2(x.bid.px) : null, ask: x.ask ? r2(x.ask.px) : null, n: x.n, pnl: r2(x.pnl), vol: Math.round(x.vol), since: x.t0 || null }])) } : null,
      cfgMr: CFG.mr,
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
  const api = { COINS, TOKS, TOK_FEE, VENUES, CFG, WD_FEE, init, fund, reset, freeUsd, step, view, mids, equity, seed, seedTok, setExt, scalpSig, scalpScores };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperCrypto = api;
})(typeof self !== 'undefined' ? self : this);
