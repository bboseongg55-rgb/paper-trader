# 자동매매 연습장 (paper-trader)

가상 자금 10만 달러로 미국 대형주를 자동으로 매매하는 연습 계좌입니다. 실제 돈과 증권 계좌는 쓰지 않으며, 투자 권유가 아닙니다.

- **화면**: https://bboseongg55-rgb.github.io/paper-trader/
- **움직이는 방식**: GitHub Actions 작업 하나가 미국 장중 내내 켜져 약 5분마다 공개 시세(API 키 없음)를 받아 `engine.js`를 돌리고 결과(`data/state.json`)를 저장합니다. 화면은 그 파일을 2분마다 다시 읽습니다.
  - 손절·추적 손절은 장중에 바로 확인합니다.
  - 손실이 나면 그 자리에서 원인을 복기하고, 같은 원인이 반복되면 규칙을 스스로 고칩니다(범위 안에서만).
  - 새 매수는 장 마감 직전(15:50 무렵, 뉴욕 시간) 가격으로 판단합니다.
  - 매일 저녁 공개 저장본의 공식 종가와 S&P 500 값으로 빠진 날을 채웁니다.
- **파일**
  - `engine.js`: 매매·리스크 관리·자기 교정 엔진
  - `tools/collect.mjs`: 장중 가격 수집, `tools/run.mjs`: 엔진 실행, `tools/feed_live.py`·`tools/merge_feed.mjs`: 저녁 종가 보충
  - `data/`: 가격 기록(`seed.json` 과거, `live.json` 연습 기간, `intraday/` 보유 종목 장중 가격)
  - `.github/workflows/trade.yml`: 실행 일정

수동 실행: Actions → trade → Run workflow (`session` 장중 수집 시작, `rebuild` 다시 계산, `probe` 가격 출처 점검).
