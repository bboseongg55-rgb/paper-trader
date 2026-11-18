#!/usr/bin/env bash
# Commits the data folder and pushes, retrying on top of anything pushed meanwhile (our new data wins on conflicts).
M="${1:-run}"
git config user.name "paper-trader-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A data
if git diff --cached --quiet; then echo "nothing to save"; exit 0; fi
git commit -q -m "data: $M $(TZ=America/New_York date '+%F %H:%M') ET"
for i in 1 2 3 4 5; do
  if git push -q 2>/dev/null; then echo "saved"; exit 0; fi
  git pull -q --rebase -X theirs >/dev/null 2>&1 || git rebase --abort >/dev/null 2>&1
  sleep 3
done
echo "push failed"; exit 1
