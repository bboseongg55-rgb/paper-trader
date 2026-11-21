// The account's allocator (shown as "AI 운용 방향"). Once per closed trading day it reads the market picture — the S&P
// 500's trend, the VIX, the high-yield credit spread, US 2- and 10-year yields, small caps against large caps,
// commodities, the dollar and bitcoin — names the regime, ranks the strategies with the numbers behind each, and sets:
// a tilt for each method of the stock and bond engine, the futures risk budget with a tilt by market group and direction,
// which option strategies and whether an ELS may be bought, the 24-hour market's weights, and each part's share of the
// account. It never trades by itself: each part follows its own rules inside these budgets. The thresholds are shown on
// the page with the decision (rules), so every call can be checked against the numbers.
(function (root) {
  'use strict';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const r4 = (v) => (isNum(v) ? Math.round(v * 1e4) / 1e4 : null);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pct = (v, d = 1) => (isNum(v) ? (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%' : '-');
  const pp = (v) => (isNum(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%p' : '-');
  const V = 5;                     // the rules' version: a new version decides again at the next run (2: call spreads, the wheel, staking; 3: the S&P 500 base layer; 4: shorts and leverage; 5: everything allowed, stocks 70 : coins 30)
  // the owner's settings (2026-11-21): every strategy may trade in every market phase (the regime only scales risk), and
  // the 24-hour part (coins) holds 30% of the account against 70% for stocks, futures and options
  const OPEN = true, COIN_SHARE = 0.3;
  const RULES = {
    vol: [16, 22, 30],             // VIX: low < 16 ≤ normal < 22 ≤ high < 30 ≤ extreme
    hyStress: 5, hyJump: 0.75, hyWiden: 0.4,
    rateMove: 0.35,                // US 2-year yield over 3 months (63 trading days), %p
    scLead: 0.02,                  // Russell 2000 minus S&P 500 over 3 months
    cmdHot: 0.1,                   // oil and copper, 3-month average
  };
  // ── a series' value on day d, and n trading days before
  function cut(m, d) { if (!m) return []; const ks = Object.keys(m).filter((k) => k <= d).sort(); return ks.map((k) => m[k]); }
  const lastOf = (a) => (a.length ? a[a.length - 1] : null);
  const ago = (a, n) => (a.length > n ? a[a.length - 1 - n] : null);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ret = (a, n) => { const x = lastOf(a), y = ago(a, n); return isNum(x) && isNum(y) && y > 0 ? x / y - 1 : null; };
  function corr(a, b, n) {
    const L = Math.min(a.length, b.length, n + 1); if (L < 60) return null;
    const ra = [], rb = []; for (let i = a.length - L + 1, j = b.length - L + 1; i < a.length; i++, j++) { ra.push(Math.log(a[i] / a[i - 1])); rb.push(Math.log(b[j] / b[j - 1])); }
    const ma = mean(ra), mb = mean(rb); let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < ra.length; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb);
  }

  // ── the market picture on day d (H: series by symbol, each {date: value})
  function picture(H, d) {
    const spx = cut(H['.SPX'], d), ndx = cut(H['.NDX'], d), rut = cut(H['.RUT'], d), vixA = cut(H['.VIX'], d), vxnA = cut(H['.VXN'], d);
    const hyA = cut(H['fred:BAMLH0A0HYM2'], d), y1A = cut(H.US1M, d), y2A = cut(H.US2Y, d), y10A = cut(H.US10Y, d), dxA = cut(H['.DXY'], d);
    const btc = cut(H['@BTC.1'], d), oil = cut(H['@CL.1'], d), cu = cut(H['@HG.1'], d), au = cut(H['@GC.1'], d);
    const p = { date: d };
    if (spx.length >= 200) {
      p.spx = lastOf(spx); p.sma50 = mean(spx.slice(-50)); p.sma200 = mean(spx.slice(-200));
      p.d50 = p.spx / p.sma50 - 1; p.d200 = p.spx / p.sma200 - 1;
      p.trend = p.spx <= p.sma200 ? 'down' : p.spx <= p.sma50 ? 'mixed' : 'up';
      p.spx63 = ret(spx, 63);
    }
    p.vix = lastOf(vixA); p.vxn = lastOf(vxnA);
    if (spx.length >= 40) { let v = 0; const s = spx.slice(-260); for (let i = 1; i < s.length; i++) { const r = s[i] / s[i - 1] - 1; v = i <= 20 ? v + (r * r) / 20 : 0.94 * v + 0.06 * r * r; } p.rv = Math.sqrt(v * 252); }
    if (isNum(p.vix)) p.volLv = p.vix < RULES.vol[0] ? 'low' : p.vix < RULES.vol[1] ? 'normal' : p.vix < RULES.vol[2] ? 'high' : 'extreme';
    p.hy = lastOf(hyA); const hy0 = ago(hyA, 63); p.dhy = isNum(p.hy) && isNum(hy0) ? p.hy - hy0 : null;
    if (isNum(p.hy)) p.credit = p.hy >= RULES.hyStress || (isNum(p.dhy) && p.dhy >= RULES.hyJump) ? 'stress' : isNum(p.dhy) && p.dhy >= RULES.hyWiden ? 'widening' : 'calm';
    p.y1m = lastOf(y1A); p.y2 = lastOf(y2A); p.y10 = lastOf(y10A);
    const y20 = ago(y2A, 63), y100 = ago(y10A, 63);
    p.dy2 = isNum(p.y2) && isNum(y20) ? p.y2 - y20 : null; p.dy10 = isNum(p.y10) && isNum(y100) ? p.y10 - y100 : null;
    p.curve = isNum(p.y10) && isNum(p.y2) ? p.y10 - p.y2 : null;
    if (isNum(p.dy2)) p.rates = p.dy2 <= -RULES.rateMove ? 'cutting' : p.dy2 >= RULES.rateMove ? 'hiking' : 'flat';
    const rr = ret(rut, 63), sr = ret(spx, 63);
    p.scRel = isNum(rr) && isNum(sr) ? rr - sr : null;
    if (isNum(p.scRel)) p.sc = p.scRel >= RULES.scLead ? 'lead' : p.scRel <= -RULES.scLead ? 'lag' : 'even';
    p.oil = ret(oil, 63); p.copper = ret(cu, 63); p.gold = ret(au, 63);
    if (isNum(p.oil) && isNum(p.copper)) { const c = (p.oil + p.copper) / 2; p.cmdMove = c; p.cmd = c >= RULES.cmdHot ? 'hot' : c <= -RULES.cmdHot ? 'cold' : 'neutral'; }
    p.dxy = ret(dxA, 63);
    if (btc.length >= 100) { p.btc = lastOf(btc); p.btc100 = mean(btc.slice(-100)); p.btcTrend = p.btc > p.btc100 ? 'up' : 'down'; p.btc63 = ret(btc, 63); }
    p.rho = corr(spx, ndx, 252);
    return p;
  }

  // ── the decision
  function decide(p, ctx) {
    ctx = ctx || {};
    const off = p.trend === 'down' || p.volLv === 'extreme' || p.credit === 'stress' || (p.trend === 'mixed' && p.volLv === 'high');
    const key = off ? 'off' : p.rates === 'cutting' ? 'cut' : p.rates === 'hiking' ? 'hike' : p.trend === 'up' && (p.volLv === 'low' || p.volLv === 'normal') ? 'bull' : 'mixed';
    const LABEL = { off: '위험 회피(시황 악화)', cut: '금리 인하 사이클', hike: '금리 상승(긴축)', bull: '강세 추세', mixed: '혼조(방향 탐색)' };
    const tags = [];
    if (p.sc === 'lead') tags.push('중소형주 강세'); else if (p.sc === 'lag') tags.push('대형주 쏠림');
    if (p.cmd === 'hot') tags.push('원자재 강세'); else if (p.cmd === 'cold') tags.push('원자재 약세');
    if (p.credit === 'widening' || p.credit === 'stress') tags.push('신용 스프레드 확대');
    if (p.btcTrend) tags.push(p.btcTrend === 'up' ? '코인 상승 추세' : '코인 하락 추세');
    if (off && p.rates === 'cutting') tags.push('금리 하락');
    if (off && p.rates === 'hiking') tags.push('금리 상승');
    // 1. the stock and bond engine: a multiplier on each method's 1-trade risk
    const C = { off: { bo: 0.5, pb: 0.5, dt: 1.25, bd: p.rates === 'hiking' ? 0.75 : 1.25 }, cut: { bo: 1, pb: 1, dt: 1, bd: 1.5 }, hike: { bo: 0.85, pb: 0.85, dt: 1.1, bd: 0.5 },
      bull: { bo: 1.25, pb: 1.1, dt: 0.85, bd: 0.75 }, mixed: { bo: 0.9, pb: 1, dt: 1.1, bd: 1 } }[key];
    // 2. futures: [long, short] multipliers by market group, and the futures risk budget (annual volatility / account)
    const eq = { off: [0.5, 1.25], cut: [1.1, 0.75], hike: [0.85, 1], bull: [1.25, 0.5], mixed: [1, 1] }[key];
    let sc = eq.slice();
    if (p.sc === 'lead') sc[0] *= 1.3; else if (p.sc === 'lag') sc[0] *= 0.75;
    if (p.rates === 'cutting') sc[0] *= 1.2;
    const rt = p.rates === 'cutting' ? [1.5, 0.5] : p.rates === 'hiking' ? [0.5, 1.5] : off ? [1.25, 0.75] : key === 'bull' ? [0.85, 1] : [1, 1];
    const cm = p.cmd === 'hot' ? [1.25, 0.75] : p.cmd === 'cold' ? [0.75, 1.25] : [1, 1];
    let cr = p.btcTrend === 'up' ? [1.1, 0.6] : p.btcTrend === 'down' ? [0.6, 1.1] : [1, 1];
    if (off) cr = [cr[0] * 0.75, cr[1]];
    const T2 = (a) => a.map((v) => Math.round(clamp(v, 0, 1.5) * 100) / 100);
    const futBudget = p.volLv === 'extreme' ? 0.03 : off ? 0.04 : key === 'bull' || key === 'cut' ? 0.06 : 0.05;
    // 3. options and ELS
    const vixIn = (lo) => isNum(p.vix) && p.vix >= lo && p.vix < RULES.vol[2];
    // put spreads in a rising market, call spreads in a falling one, both (an iron condor) when it goes sideways
    // the S&P 500 base layer is always allowed; each night it sells only while options are dearer than the realised-vol
    // forecast (checked on the closing chain). It replaces the 20-delta put spreads and the IWM wheel, which sold the
    // same premium without its loss budget, so short puts never stack
    const base = true;
    const credit = OPEN || (!base && !off && ((p.trend === 'up' && vixIn(15)) || (p.trend === 'mixed' && vixIn(18))));
    const callCredit = OPEN || (p.credit !== 'stress' && vixIn(18) && (p.trend === 'down' || (p.trend === 'mixed' && !off)));
    // the wheel on IWM (cash-secured put, then covered calls): when the market is not falling and premiums pay; it ties
    // up IWM's price × 100 in cash, at most 30% of the account
    const iwm = isNum(ctx.iwm) ? ctx.iwm : null, acct = isNum(ctx.account) && ctx.account > 0 ? ctx.account : null;
    const wheelShare = iwm && acct ? (iwm * 100 * 1.05) / acct : null, affordable = wheelShare != null && wheelShare <= 0.3;
    const wheel = OPEN ? affordable : !base && !off && p.trend !== 'down' && vixIn(15) && affordable;
    const heldShare = acct && isNum(ctx.wheelHeld) ? ctx.wheelHeld / acct : 0;
    // protection is bought only while it is still cheap (VIX under 22): bought after a crash it costs more than it saves
    const expo = isNum(ctx.exposure) ? ctx.exposure : 0, hedge = OPEN ? expo >= 20000 : off && expo >= 20000 && isNum(p.vix) && p.vix < 22;
    const cpn = isNum(ctx.elsCoupon) ? ctx.elsCoupon : null;
    const elsOn = OPEN || (isNum(p.vix) && p.vix >= 20 && !(p.trend === 'down' && p.volLv === 'extreme') && p.credit !== 'stress' && (cpn == null || cpn >= 0.07));
    const elsMax = off ? 0.05 : 0.1;
    // 4. the 24-hour market (coins and tokenized stocks): multipliers on its own weights
    const h24 = { trend: OPEN ? 1 : p.btcTrend === 'up' ? 1.2 : p.btcTrend === 'down' ? 0.7 : 1,   // coin trends trade both ways now, so a falling bitcoin no longer cuts them scalp: p.volLv === 'extreme' ? 0.75 : 1, arb: 1,
      tok: off ? 0.5 : key === 'bull' ? 1.25 : 1, tokSmall: p.sc === 'lead' ? 1.3 : 1 };
    // 5. each part's share of the account
    const h24T = OPEN ? COIN_SHARE : p.volLv === 'extreme' ? 0.05 : off ? 0.07 : key === 'bull' && p.btcTrend === 'up' ? 0.12 : 0.1;
    // derivatives take at most half of the non-coin part, so individual stocks and bonds keep at least the other half
    const derivT = Math.min(OPEN ? (1 - h24T) / 2 : 0.7, 0.12 + (elsOn ? elsMax : 0) + Math.max(wheel ? wheelShare : 0, heldShare) + (base ? 0.15 : 0));
    const target = { core: Math.round((1 - h24T - derivT) * 100) / 100, deriv: Math.round(derivT * 100) / 100, h24: h24T };

    // what to do first, and why (the numbers that decided it)
    const spxTxt = isNum(p.d200) ? `S&P 500 200일선 ${pct(p.d200)}·50일선 ${pct(p.d50)}` : 'S&P 500 추세 자료 없음';
    const vixTxt = isNum(p.vix) ? `VIX ${p.vix.toFixed(1)}` : 'VIX 자료 없음';
    const rateTxt = isNum(p.dy2) ? `미 2년 금리 3개월 ${pp(p.dy2)}(${p.y2.toFixed(2)}%)` : '미 금리 자료 없음';
    const scTxt = isNum(p.scRel) ? `러셀 2000이 S&P 500보다 3개월 ${pct(p.scRel)}` : '';
    const rp = isNum(p.y1m) ? Math.max(0, p.y1m - 0.25) : null;
    const it = [
      { k: 'dt', name: '단타(주식, 당일 청산)', w: C.dt, on: true,
        why: off ? `${spxTxt}, ${vixTxt}: 시황이 나빠 밤사이 위험이 없는 단타를 앞세웁니다.` : `그날 시장보다 강한 종목만 짧게 노립니다(위험 ${Math.round(C.dt * 100)}%).` },
      { k: 'bo', name: '신고가 돌파 스윙', w: C.bo, on: OPEN || p.trend !== 'down',
        why: p.trend === 'down' ? `${spxTxt}: 하락 추세에서는 신고가 돌파가 되밀리기 쉬워 새 매수를 쉽니다.` : key === 'bull' ? `${spxTxt}, ${vixTxt}: 안정된 상승장이라 돌파 종목의 추세가 이어지기 쉽습니다.` : `${spxTxt}: 위험을 ${Math.round(C.bo * 100)}%로 둡니다.` },
      { k: 'pb', name: '눌림목 스윙', w: C.pb, on: OPEN || p.trend !== 'down', why: p.trend === 'down' ? '하락 추세의 눌림은 반등보다 추가 하락이 잦아 쉽니다.' : `상승 추세 안의 짧은 하락을 삽니다(위험 ${Math.round(C.pb * 100)}%).` },
      { k: 'bd', name: '채권(각국 국채·회사채)', w: C.bd, on: true,
        why: p.rates === 'cutting' ? `${rateTxt}: 금리 인하 사이클에는 채권 가격이 오르기 쉬워 채권 비중을 늘립니다.` : p.rates === 'hiking' ? `${rateTxt}: 금리가 오르는 동안 채권 가격은 내리기 쉬워 줄입니다.` : `${rateTxt}: 추세가 확인된 채권만 삽니다.` },
      { k: 'sc', name: '중소형주 스윙(러셀 2000 선물)', w: sc[0], on: OPEN || (p.trend !== 'down' && p.sc !== 'lag'),
        why: [scTxt, p.rates === 'cutting' ? '금리 인하 사이클은 빚이 많은 중소형주에 유리' : ''].filter(Boolean).join(', ') + (p.sc === 'lead' || p.rates === 'cutting' ? ' → 중소형주 매수 비중을 늘립니다.' : '. 추세가 맞을 때만 삽니다.') },
      { k: 'cta', name: '선물 추세추종(지수·국채·원자재·코인)', w: off ? 1 : futBudget / 0.05, on: true,
        why: `선물 위험 한도 연 ${Math.round(futBudget * 100)}%(계좌 대비 변동성). ${off ? '하락 추세 시장은 매도 포지션도 잡습니다.' : '여러 시장에 나눠 추세를 따릅니다.'}${p.cmd === 'hot' ? ` 원유·구리 3개월 ${pct(p.cmdMove)}로 원자재 매수 쪽을 늘립니다.` : ''}` },
      { k: 'base', name: 'S&P 500 기반층(SPY 풋 스프레드 매도)', w: 1.5, on: base,
        why: `${vixTxt}${isNum(p.rv) ? `, 실현 변동성 예측 ${(p.rv * 100).toFixed(1)}%` : ''}: 옵션값이 실제 흔들림 예측보다 비쌀 때만 매달 SPY 등가격 풋을 팔고 10% 아래 풋을 사서, 받은 값은 챙기고 최악 손실은 계좌의 12%(처음 3개월은 6%) 안으로 묶습니다. 밤에 장 마감 호가로 판단하고 만기까지 들고 갑니다.` },
      { k: 'credit', name: '옵션 프리미엄 매도(SPY 풋 스프레드)', w: credit ? 1 : 0, on: credit,
        why: credit ? (callCredit ? `${spxTxt}, ${vixTxt}: 방향이 없고 옵션값이 비싸 풋·콜 스프레드를 함께 파는 아이언 콘도르로 운용합니다.` : `${spxTxt}, ${vixTxt}: 상승 추세에 옵션값이 비싸 손실 한도가 정해진 풋 스프레드를 팝니다.`)
          : base ? 'S&P 500 기반층이 같은 풋 프리미엄을 손실 한도와 함께 받으므로 겹치지 않게 쉽니다.' : `상승 추세이면서 VIX가 15~30이거나, 횡보이면서 18~30일 때만 팝니다(지금 ${isNum(p.vix) ? p.vix.toFixed(1) : '-'}).` },
      { k: 'callCredit', name: '옵션 프리미엄 매도(SPY 콜 스프레드)', w: callCredit ? 1 : 0, on: callCredit,
        why: callCredit ? (credit ? `${vixTxt}: 풋 스프레드와 함께 파는 아이언 콘도르의 위쪽입니다. 지수가 크게 오르지 않으면 프리미엄을 받습니다.` : `${spxTxt}, ${vixTxt}: 지수가 오르기 어려운 국면에 옵션값이 비싸 손실 한도가 정해진 콜 스프레드를 팝니다.`)
          : `하락·횡보 추세이면서 VIX가 18~30일 때만 팝니다(지금 ${isNum(p.vix) ? p.vix.toFixed(1) : '-'}).` },
      { k: 'wheel', name: '커버드콜·현금 담보 풋(IWM 휠)', w: wheel ? 1 : 0, on: wheel,
        why: wheel ? `${spxTxt}, ${vixTxt}: 러셀 2000 ETF(IWM) 풋을 현금 담보로 팔아 프리미엄을 받고, 주식을 받게 되면 그 위에 커버드콜을 팝니다(계좌의 약 ${Math.round(wheelShare * 100)}%를 담보로 씀).`
          : base ? 'S&P 500 기반층이 같은 풋 프리미엄을 받으므로 겹치지 않게 쉽니다(들고 있던 IWM은 커버드콜로 정리합니다).'
          : off ? '위험 회피 국면에는 주식을 떠안지 않도록 쉽니다(들고 있던 IWM은 콜을 되사고 정리).'
          : wheelShare != null && !affordable ? `IWM 100주(약 $${Math.round(iwm * 100).toLocaleString('en-US')})가 계좌의 30%를 넘어 쉽니다.`
          : iwm == null ? 'IWM 시세를 아직 받지 못해 다음 판단 때 정합니다.' : `하락 추세가 아니고 VIX가 15~30일 때만 합니다(지금 ${isNum(p.vix) ? p.vix.toFixed(1) : '-'}).` },
      { k: 'hedge', name: '보호 풋 스프레드(하락 대비)', w: hedge ? 1.2 : 0, on: hedge,
        why: hedge ? `위험 회피 국면이고 보호 비용이 아직 싸서(${vixTxt}) 계좌의 주식 등 $${Math.round(expo).toLocaleString('en-US')}의 절반만큼 SPY 풋 스프레드로 하락을 대비합니다.`
          : off && expo < 20000 ? `위험 회피 국면이지만 지킬 주식 보유가 $${Math.round(expo).toLocaleString('en-US')}로 작아(기준 $20,000) 사지 않습니다.`
          : off ? `${vixTxt}: 이미 옵션값이 비싸 지금 사는 보호는 비용이 더 큽니다(VIX 22 미만일 때만 삽니다). 대신 주식 쪽 S&P 500 인버스 헷지와 선물 매도가 하락에 대비합니다.` : '위험 회피 국면에, 옵션값이 쌀 때(VIX 22 미만)만 삽니다.' },
      { k: 'els', name: 'ELS(S&P 500·나스닥 100 스텝다운)', w: elsOn ? 0.9 : 0, on: elsOn,
        why: elsOn ? `${vixTxt}: 변동성이 높아 ELS 쿠폰이 높습니다${cpn != null ? `(지금 조건이면 연 ${(cpn * 100).toFixed(1)}%)` : ''}. 계좌의 ${Math.round(elsMax * 100)}% 한도 안에서 삽니다.`
          : cpn != null && isNum(p.vix) && p.vix >= 20 ? `지금 조건의 ELS 쿠폰이 연 ${(cpn * 100).toFixed(1)}%로 기준(연 7%)보다 낮아 사지 않습니다.` : 'VIX가 20 이상이고 쿠폰이 연 7% 이상일 때만 삽니다.' },
      { k: 'sb', name: '하락 돌파 공매도(주식)', w: 1 / 6, on: true,
        why: `시장 국면과 상관없이, 50일 최저가를 깬 하락 추세·상대강도 하위 30% 종목을 공매도합니다(손절은 위쪽, 대여료 연 0.5%, 판 금액의 150% 증거금). 2년 시험이 손실이라 보통의 1/6 위험으로 시작합니다. 주식 쪽 레버리지는 계좌의 1.5배까지 허용합니다.` },
      { k: 'perp', name: '코인 무기한 선물(매수·공매도)', w: h24.trend, on: true,
        why: '코인 추세 매매를 무기한 선물로 합니다: 20시간 신고가면 매수, 20시간 신저가(100시간 평균 아래)면 공매도, 매수·공매도 같은 위험, 증거금의 최대 5배, 선물 전체 명목은 코인 계좌의 3배 이내. 증거금 80%를 잃기 전에 정리합니다.' },
      { k: 'crypto', name: '코인(거래소 간 차익·추세·초단타)', w: h24.trend, on: true,
        why: p.btcTrend ? `비트코인이 100일 평균 ${p.btcTrend === 'up' ? '위' : '아래'}(${pct(p.btc / p.btc100 - 1)})라 추세 매매 위험을 ${Math.round(h24.trend * 100)}%로 둡니다.` : '코인 추세 자료 없음.' },
      { k: 'tok', name: '토큰화 주식(코인 거래소, 24시간)', w: h24.tok, on: true,
        why: off ? '시황이 나빠 장 마감 뒤 주식 토큰 매수를 줄입니다.' : '미국 장이 닫힌 밤·주말에도 코인 거래소의 주식 토큰으로 추세를 따릅니다.' },
      { k: 'stake', name: '코인 스테이킹·달러 보상(ETH·SOL·USDC)', w: 1, on: true,
        why: '들고 있는 ETH·SOL은 스테이킹 보상을, 코인 거래소에서 기다리는 달러는 USDC 보상을 받습니다. 가격 위험은 늘리지 않고 이자만 더합니다(수익률은 공개 유동 스테이킹 기준에서 거래소 수수료 25%를 뺀 값, 확인필요).' },
      { k: 'rp', name: 'RP(남는 현금)', w: off ? 1 : 0.5, on: true, why: isNum(rp) ? `쓰지 않는 현금은 연 ${rp.toFixed(2)}%(미 1개월 국채 ${p.y1m.toFixed(2)}% − 0.25%p)의 RP 이자를 받습니다.` : '쓰지 않는 현금은 RP 이자를 받습니다.' },
    ];
    it.sort((a, b) => (b.on - a.on) || (b.w - a.w));
    let rank = 0;
    for (const x of it) { x.rank = x.on ? ++rank : null; x.w = Math.round(x.w * 100) / 100; x.lean = !x.on ? '쉼' : x.w > 1.001 ? '확대' : x.w < 0.999 ? '축소' : '보통'; }
    // first: what is on at full weight or more (at most three), else the single strongest
    let lead = it.filter((x) => x.on && x.w >= 1).slice(0, 3);
    if (!lead.length) lead = it.filter((x) => x.on).slice(0, 1);
    const top = lead.map((x) => x.name.replace(/\(.*\)/, ''));
    const headline = `${LABEL[key]}${tags.length ? ' · ' + tags.slice(0, 2).join(' · ') : ''} → ${top.join('·')} 우선`;
    const signals = [
      isNum(p.d200) ? { k: 'S&P 500 추세', v: { up: '상승', mixed: '약세', down: '하락' }[p.trend], c: p.trend === 'up' ? 'up' : 'down', sub: `200일선 ${pct(p.d200)} · 50일선 ${pct(p.d50)}` } : null,
      isNum(p.vix) ? { k: 'VIX(변동성)', v: p.vix.toFixed(1), sub: { low: '낮음', normal: '보통', high: '높음', extreme: '극단' }[p.volLv] + (isNum(p.vxn) ? ` · 나스닥 VXN ${p.vxn.toFixed(1)}` : '') } : null,
      isNum(p.hy) ? { k: '하이일드 스프레드', v: p.hy.toFixed(2) + '%', sub: `3개월 ${pp(p.dhy)} · ${{ calm: '안정', widening: '확대', stress: '경색' }[p.credit]}` } : null,
      isNum(p.y2) ? { k: '미 2년 금리', v: p.y2.toFixed(2) + '%', sub: `3개월 ${pp(p.dy2)} · ${{ cutting: '인하 기대', hiking: '인상 압력', flat: '보합' }[p.rates]}` } : null,
      isNum(p.curve) ? { k: '장단기 금리차(10년−2년)', v: pp(p.curve), sub: p.curve < 0 ? '역전: 경기 둔화 신호' : p.curve < 0.5 ? '평평' : '정상' } : null,
      isNum(p.scRel) ? { k: '중소형주(러셀 2000)', v: pct(p.scRel), c: p.scRel >= 0 ? 'up' : 'down', sub: 'S&P 500 대비 3개월' } : null,
      isNum(p.cmdMove) ? { k: '원자재(원유·구리)', v: pct(p.cmdMove), c: p.cmdMove >= 0 ? 'up' : 'down', sub: `3개월 · 금 ${pct(p.gold)}` } : null,
      isNum(p.dxy) ? { k: '달러(DXY)', v: pct(p.dxy), sub: '3개월' } : null,
      p.btcTrend ? { k: '비트코인', v: pct(p.btc / p.btc100 - 1), c: p.btcTrend === 'up' ? 'up' : 'down', sub: '100일 평균 대비' } : null,
    ].filter(Boolean);
    const rules = [
      '위험 회피: S&P 500이 200일선 아래, VIX 30 이상, 하이일드 스프레드 5% 이상 또는 3개월 +0.75%p, 50일선 아래이면서 VIX 22 이상 중 하나',
      '금리 인하 사이클 / 금리 상승: 미 2년 금리 3개월 변화 −0.35%p 이하 / +0.35%p 이상',
      '강세 추세: S&P 500이 50일·200일선 위이고 VIX 22 미만',
      '중소형주 강세: 러셀 2000이 S&P 500보다 3개월 2%p 이상 앞섬 · 원자재 강세: 원유·구리 3개월 평균 +10% 이상',
      'S&P 500 기반층: 등가격 풋의 내재 변동성 > 실현 변동성 예측(지수 일간 수익률의 지수가중 평균, λ 0.94)일 때만 팝니다. 최악 손실 = (행사가 폭 − 받은 값) × 계약 수 ≤ 계좌의 12%(처음 3개월 6%), 명목 금액 ≤ 계좌의 1.5배',
      '배분은 매일 저녁 한 번 정하고, 각 매매는 이 한도 안에서 자기 규칙(손절·추세 확인)으로 사고팝니다',
    ];
    return {
      v: V, date: p.date, regime: { key, label: LABEL[key], tags, off }, headline, items: it, signals, rules,
      tilt: { core: C, fut: { budget: futBudget, tilt: { eq: T2(eq), sc: T2(sc), rt: T2(rt), cm: T2(cm), cr: T2(cr) } }, opt: { base, credit, callCredit, wheel, hedge, off: OPEN ? false : off, ratio: p.volLv === 'extreme' ? 0.75 : 0.5 },
        els: { on: elsOn, max: elsMax, minCoupon: 0.07, coupon: cpn != null ? r4(cpn) : null }, h24 },
      target, rp: isNum(rp) ? r4(rp / 100) : null,
      pic: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? r4(v) : v])),
    };
  }

  const api = { V, RULES, picture, decide };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CIO = api;
})(typeof self !== 'undefined' ? self : this);
