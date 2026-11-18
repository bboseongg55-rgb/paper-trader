#!/usr/bin/env bash
# One US market session in a single GitHub Actions job: every 5 minutes it collects prices, runs the engine and saves
# the data (the page reads data/state.json straight from the repository). It waits for the open, stops once today's
# closing row is saved, and ends before GitHub's 6-hour job limit; the hourly schedule then starts the next one.
set -u
git config user.name "paper-trader-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
START=$(date +%s); LIMIT=$((START + 340 * 60))
while :; do
  NOW=$(date +%s)
  if [ "$NOW" -ge "$LIMIT" ]; then echo "job time limit reached; the next scheduled run takes over"; break; fi
  read -r DATE HM DOW <<<"$(TZ=America/New_York date '+%F %H:%M %u')"
  if [ "$DOW" -ge 6 ] || [[ "$HM" > "16:45" ]]; then echo "session over ($DATE $HM)"; break; fi
  if [[ "$HM" < "09:35" ]]; then sleep 30; continue; fi
  git pull -q --rebase -X theirs >/dev/null 2>&1 || git rebase --abort >/dev/null 2>&1
  OUT=$(node tools/collect.mjs 2>&1 | tail -1)
  echo "$DATE $HM ${OUT:0:260}"
  if echo "$OUT" | grep -q '"changed":true'; then
    node tools/run.mjs 2>&1 | tail -1 | cut -c1-260
    bash tools/save.sh session || true
  fi
  if echo "$OUT" | grep -q -e '오늘 종가 이미 확정' -e '휴장일'; then echo "done for today"; break; fi
  NOW=$(date +%s); NEXT=$(( (NOW / 300 + 1) * 300 + 20 )); sleep $(( NEXT - NOW ))
done
