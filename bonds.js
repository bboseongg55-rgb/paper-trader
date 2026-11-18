/* 채권: 각국 국채와 채권 ETF를 엔진이 매매할 수 있는 가격 지수로 만듭니다.
   Government bonds by country are synthetic: a constant-maturity bond whose daily return in its own currency is the
   carry (yield × days / 365), minus modified duration × the change in yield, plus half the convexity × the change
   squared; the return in US dollars adds the currency's move against the dollar (unhedged). The yields and currencies
   are CNBC's public quotes (history from CNBC's daily bars). This is an approximation of holding the country's
   benchmark bond: it ignores roll-down, the bid-ask spread beyond the engine's slippage, and taxes. Bond ETFs
   (corporate, high yield, emerging markets, inflation-linked, municipal, international) are real US-listed funds:
   their index adds each distribution on its ex-date to the price, so it is a total return. */
(function (root) {
  'use strict';
  // CNBC yield symbol, our key, name, CNBC currency symbol ('' for US dollar bonds), currency quote ('usd' = dollars per
  // unit, 'per' = units per dollar), maturity in years
  const GOV = [
    ['US2Y', 'US2Y', '미국 2년 국채', '', '', 2], ['US5Y', 'US5Y', '미국 5년 국채', '', '', 5],
    ['US10Y', 'US10Y', '미국 10년 국채', '', '', 10], ['US30Y', 'US30Y', '미국 30년 국채', '', '', 30],
    ['DE10Y-DE', 'DE10Y', '독일 10년 국채', 'EUR=', 'usd', 10], ['GB10Y-GB', 'GB10Y', '영국 10년 국채', 'GBP=', 'usd', 10],
    ['JP10Y-JP', 'JP10Y', '일본 10년 국채', 'JPY=', 'per', 10], ['FR10Y-FR', 'FR10Y', '프랑스 10년 국채', 'EUR=', 'usd', 10],
    ['IT10Y-IT', 'IT10Y', '이탈리아 10년 국채', 'EUR=', 'usd', 10], ['ES10Y-ES', 'ES10Y', '스페인 10년 국채', 'EUR=', 'usd', 10],
    ['PT10Y-PT', 'PT10Y', '포르투갈 10년 국채', 'EUR=', 'usd', 10], ['GR10Y-GR', 'GR10Y', '그리스 10년 국채', 'EUR=', 'usd', 10],
    ['NL10Y-NL', 'NL10Y', '네덜란드 10년 국채', 'EUR=', 'usd', 10], ['CH10Y-CH', 'CH10Y', '스위스 10년 국채', 'CHF=', 'per', 10],
    ['SE10Y-SE', 'SE10Y', '스웨덴 10년 국채', 'SEK=', 'per', 10], ['CA10Y-CA', 'CA10Y', '캐나다 10년 국채', 'CAD=', 'per', 10],
    ['AU10Y-AU', 'AU10Y', '호주 10년 국채', 'AUD=', 'usd', 10], ['NZ10Y-NZ', 'NZ10Y', '뉴질랜드 10년 국채', 'NZD=', 'usd', 10],
    ['KR10Y-KR', 'KR10Y', '한국 10년 국채', 'KRW=', 'per', 10], ['CN10Y-CN', 'CN10Y', '중국 10년 국채', 'CNY=', 'per', 10],
    ['BR10Y-BR', 'BR10Y', '브라질 10년 국채', 'BRL=', 'per', 10],
    ['MX10Y-MX', 'MX10Y', '멕시코 10년 국채', 'MXN=', 'per', 10], ['ZA10Y-ZA', 'ZA10Y', '남아공 10년 국채', 'ZAR=', 'per', 10],
    ['SG10Y-SG', 'SG10Y', '싱가포르 10년 국채', 'SGD=', 'per', 10],
    ['ID10Y-ID', 'ID10Y', '인도네시아 10년 국채', 'IDR=', 'per', 10], ['TR10Y-TR', 'TR10Y', '튀르키예 10년 국채', 'TRY=', 'per', 10],
  ];
  // only funds whose distributions the history source gives (2026-11-18: Nasdaq had none for LQD, HYG, JNK, USHY, EMLC,
  // PCY, BWX, TIP, MUB, FLOT, so their total return could not be built and they are left out)
  const ETF = [
    ['VCIT', '미국 중기 회사채 ETF'], ['VCSH', '미국 단기 회사채 ETF'], ['IGIB', '미국 중기 회사채 ETF(iShares)'],
    ['EMB', '신흥국 달러 국채 ETF'], ['BNDX', '해외 투자등급 채권 ETF(환헤지)'], ['IGOV', '해외 선진국 국채 ETF'],
  ];
  const FX = [...new Set(GOV.map((g) => g[3]).filter(Boolean))];
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const dayGap = (a, b) => Math.max(1, Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5));
  // modified duration of a par bond with half-yearly coupons (yield in percent)
  function parDur(y, n) { const a = Math.max(y, 0.05) / 100; return (1 - Math.pow(1 + a / 2, -2 * n)) / a; }

  // value on each date: the saved history up to its last day, then the collected rows (bx), the last known value carried forward
  function series(hist, days, kind, sym, dates) {
    const h = (hist && hist[kind] && hist[kind][sym]) || {};
    const live = new Map();
    for (const d of days || []) { const v = d.bx && d.bx[kind] && d.bx[kind][sym]; if (isNum(v) && v > 0 || (kind === 'y' && isNum(v))) live.set(d.date, v); }
    const asOf = (hist && hist.asOf) || '';
    const out = new Array(dates.length).fill(NaN);
    let last = NaN;
    for (let t = 0; t < dates.length; t++) {
      const d = dates[t];
      let v = d > asOf && live.has(d) ? live.get(d) : h[d];
      if (!isNum(v) && live.has(d)) v = live.get(d);
      if (isNum(v)) last = v;
      out[t] = last;
    }
    return out;
  }

  // instruments for the engine, aligned to the engine's trading days
  function build(hist, days, dates) {
    const out = [];
    const fx = {};
    for (const f of FX) fx[f] = series(hist, days, 'fx', f, dates);
    for (const [ysym, key, name, fsym, conv, n] of GOV) {
      const y = series(hist, days, 'y', ysym, dates), q = fsym ? fx[fsym] : null;
      const c = new Array(dates.length).fill(NaN);
      let idx = NaN;
      for (let t = 0; t < dates.length; t++) {
        if (!isNum(y[t]) || (q && !isNum(q[t]))) continue;
        if (!isNum(idx)) { idx = 100; c[t] = idx; continue; }
        const y0 = y[t - 1], y1 = y[t];
        if (!isNum(y0)) { c[t] = idx; continue; }
        const D = parDur(y0, n), dy = (y1 - y0) / 100;
        let r = (y0 / 100) * dayGap(dates[t - 1], dates[t]) / 365 - D * dy + 0.5 * D * D * dy * dy;
        if (q && isNum(q[t - 1])) { const u0 = conv === 'usd' ? q[t - 1] : 1 / q[t - 1], u1 = conv === 'usd' ? q[t] : 1 / q[t]; r = (1 + r) * (u1 / u0) - 1; }
        idx *= 1 + r;
        c[t] = idx;
      }
      out.push({ s: key, n: name + '(합성)', sec: '채권', kind: 'bond', syn: true, c, y, ccy: fsym ? fsym.replace('=', '') : 'USD' });
    }
    for (const [sym, name] of ETF) {
      const p = series(hist, days, 'etf', sym, dates);
      const div = new Map(((hist && hist.div && hist.div[sym]) || []).map(([d, a]) => [d, a]));
      const c = new Array(dates.length).fill(NaN);
      let idx = NaN;
      for (let t = 0; t < dates.length; t++) {
        if (!isNum(p[t])) continue;
        if (!isNum(idx)) { idx = p[t]; c[t] = idx; continue; }
        let dv = 0;
        for (const [d, a] of div) if (d > dates[t - 1] && d <= dates[t]) dv += a;      // distributions with an ex-date since the last day
        idx *= (p[t] + dv) / p[t - 1];
        c[t] = idx;
      }
      out.push({ s: sym, n: name, sec: '채권', kind: 'bond', syn: false, c, px: p });
    }
    return out;
  }

  const api = { GOV, ETF, FX, build, parDur };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperBonds = api;
})(typeof self !== 'undefined' ? self : this);
