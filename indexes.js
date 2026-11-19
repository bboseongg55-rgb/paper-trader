// Indexes the page can compare the account with: key, CNBC symbol, name, short chip label, group.
// Used by tools/collect.mjs (live levels during the session), tools/macro_hist.mjs (daily history) and tools/run.mjs.
(function (root) {
  'use strict';
  const LIST = [
    ['spx', '.SPX', 'S&P 500', 'S&P 500', '미국'], ['ndx', '.NDX', '나스닥 100', '나스닥 100', '미국'], ['dji', '.DJI', '다우존스', '다우', '미국'], ['rut', '.RUT', '러셀 2000(중소형주)', '러셀 2000', '미국'],
    ['kospi', '.KS11', '코스피', '코스피', '한국'], ['kosdaq', '.KQ11', '코스닥', '코스닥', '한국'],
    ['n225', '.N225', '닛케이 225', '닛케이', '아시아'], ['twii', '.TWII', '대만 가권', '대만', '아시아'], ['hsi', '.HSI', '항셍', '항셍', '아시아'], ['ssec', '.SSEC', '상하이 종합', '상하이', '아시아'], ['nifty', '.NSEI', '인도 니프티 50', '인도', '아시아'],
    ['stoxx', '.STOXX50E', '유로스톡스 50', '유로스톡스', '유럽'], ['dax', '.GDAXI', '독일 DAX', 'DAX', '유럽'], ['ftse', '.FTSE', '영국 FTSE 100', 'FTSE', '유럽'], ['cac', '.FCHI', '프랑스 CAC 40', 'CAC', '유럽'],
    ['tsx', '.GSPTSE', '캐나다 S&P/TSX', 'TSX', '캐나다'],
    ['gold', '@GC.1', '금(선물)', '금', '자산'], ['btc', 'BTC.CM=', '비트코인', '비트코인', '자산'], ['eth', 'ETH.CM=', '이더리움', '이더리움', '자산'],
  ].map(([k, sym, name, chip, group]) => ({ k, sym, name, chip, group }));
  const api = { LIST, BY: Object.fromEntries(LIST.map((x) => [x.k, x])) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.INDEXES = api;
})(typeof self !== 'undefined' ? self : this);
