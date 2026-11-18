"""Build the price history the paper-trading engine starts from.

Sources (public, no key):
  * github.com/rreichel3/US-Stock-Symbols : evening snapshot of the Nasdaq stock screener for every US-listed stock
    (last sale, net change, % change, market cap, sector), one git commit per evening.
  * github.com/ravelab/l-etf data/index-sp.csv : S&P 500 close per trading day.

Date alignment: an evening snapshot sometimes still shows the PREVIOUS trading day (Nasdaq refreshes its table at a
varying hour). Each snapshot is dated by matching the cap-weighted % change of the biggest stocks with the S&P 500
move of the labelled day and of the day before; unclear snapshots follow their neighbours. A day without a snapshot
is filled from the next snapshot's previous-close values (last sale − net change).

Output: seed.json with split-adjusted daily closes for every stock worth >= $20B on at least one day, a point-in-time
eligibility mask (cap >= $20B and price >= $5 that day) and the S&P 500 close.
Usage: python3 build_seed.py <uss_repo_dir> <letf_repo_dir> <out.json> [since=2023-12-15] [last_date=] [--live-after=YYYY-MM-DD]
With --live-after the script writes the nightly file instead: raw closes (official where known), the exchange's % change
and market cap for every stock worth >= $15B, for each trading day after that date. The app adjusts splits itself.
"""
import json, os, re, subprocess, sys, math
from datetime import date, datetime, timezone, timedelta
from zoneinfo import ZoneInfo

USS, LETF, OUT = sys.argv[1:4]
SINCE = sys.argv[4] if len(sys.argv) > 4 else "2023-12-15"
LAST = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] and not sys.argv[5].startswith("--") else None
LIVE_AFTER = next((a.split("=", 1)[1] for a in sys.argv[4:] if a.startswith("--live-after=")), None)
ET = ZoneInfo("America/New_York")
FILES = ["nasdaq/nasdaq_full_tickers.json", "nyse/nyse_full_tickers.json", "amex/amex_full_tickers.json"]
CAP_KEEP, CAP_UNIVERSE, MIN_PRICE, START = 2e9, 20e9, 5.0, "2024-01-02"
HOLIDAYS = {"2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"}
BAD_NAME = re.compile(r"warrant|\bunits?\b|\bright(s)?\b|preferred|pfd|depositary shares representing|notes due|debenture|subordinated|trust preferred|% ", re.I)
env = dict(os.environ, GIT_NO_LAZY_FETCH="1")


def git(*args):
    return subprocess.run(["git", "-C", USS, *args], capture_output=True, check=True, env=env).stdout


def num(s):
    s = (s or "").replace("$", "").replace("%", "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


# ── 1. trading calendar: S&P file dates, then weekdays that are not exchange holidays
cal, spx = [], {}
for line in subprocess.run(["git", "-C", LETF, "show", "HEAD:data/index-sp.csv"], capture_output=True, check=True, text=True).stdout.splitlines()[1:]:
    p = line.split(",")
    if len(p) >= 4 and p[0] >= START:
        cal.append(p[0]); spx[p[0]] = float(p[3])
d = date.fromisoformat(cal[-1]) + timedelta(days=1)
while d <= date.today() + timedelta(days=1):
    if d.weekday() < 5 and d.isoformat() not in HOLIDAYS:
        cal.append(d.isoformat())
    d += timedelta(days=1)
pos = {x: i for i, x in enumerate(cal)}
sret = {cal[i]: spx[cal[i]] / spx[cal[i - 1]] - 1 for i in range(1, len(cal)) if cal[i] in spx and cal[i - 1] in spx}
print("S&P 500 rows to", max(spx), "| calendar to", cal[-1], flush=True)

# ── 2. snapshots: latest commit per evening
subprocess.run(["git", "-C", USS, "fetch", "-q", "--shallow-since=" + SINCE, "--filter=blob:none", "origin"], check=True, env=env)
head = "origin/HEAD" if subprocess.run(["git", "-C", USS, "rev-parse", "-q", "--verify", "origin/HEAD"], capture_output=True).returncode == 0 else "HEAD"
snaps = {}
for row in git("log", "--format=%H %ct", head).decode().split("\n"):
    if not row.strip():
        continue
    h, ts = row.split()
    t = datetime.fromtimestamp(int(ts), timezone.utc).astimezone(ET)
    lab = (t - timedelta(days=1) if t.hour < 9 else t).date().isoformat()
    if lab >= START and lab not in snaps:
        snaps[lab] = h
labels = sorted(snaps)
oids = {}
for lab in labels:
    out = git("ls-tree", snaps[lab], *FILES).decode().splitlines()
    oids[lab] = [ln.split()[2] for ln in out]
need = sorted({o for v in oids.values() for o in v})
present = {ln.split()[0] for ln in git("cat-file", "--batch-check=%(objectname) %(objecttype)", "--batch-all-objects", "--unordered").decode().splitlines() if ln.endswith(" blob")}
miss = [o for o in need if o not in present]
print("snapshots", len(labels), "| blobs", len(need), "missing", len(miss), flush=True)
for i in range(0, len(miss), 250):
    subprocess.run(["git", "-C", USS, "-c", "fetch.negotiationAlgorithm=noop", "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--filter=blob:none", "origin", *miss[i:i + 250]], check=True, env=env)
    print("  fetched", min(i + 250, len(miss)), flush=True)


def read_snapshot(lab, proc):
    rows = {}
    for o in oids[lab]:
        proc.stdin.write((o + "\n").encode()); proc.stdin.flush()
        hdr = proc.stdout.readline().split()
        if len(hdr) < 3:
            continue
        body = proc.stdout.read(int(hdr[2])); proc.stdout.read(1)
        try:
            data = json.loads(body)
        except Exception:
            continue
        for r in data:
            cap, px = num(r.get("marketCap")), num(r.get("lastsale"))
            if not cap or cap < CAP_KEEP or not px or px <= 0:
                continue
            rows[r["symbol"].strip()] = (px, num(r.get("netchange")), num(r.get("pctchange")), cap, r.get("name", ""), r.get("sector", "") or "", num(r.get("volume")) or 0)
    return rows


# ── 3. pass 1: date each snapshot
# (a) the previous-close column links consecutive evenings exactly: equal previous closes = same trading day,
#     previous close equal to the last evening's price = the next trading day. (b) where that link is broken (a missing
#     evening), the S&P 500 move decides between the labelled day and the day before.
proc = subprocess.Popen(["git", "-C", USS, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
status, big, conf = {}, {}, {}
for lab in labels:
    rows = read_snapshot(lab, proc)
    w = s_ = 0.0
    big[lab] = {}
    for sym, (px, nc, pc, cap, *_) in rows.items():
        if cap >= 50e9 and pc is not None and abs(pc) < 30:
            w += cap; s_ += cap * pc / 100
        if cap >= 50e9 and nc is not None and px - nc > 0:
            big[lab][sym] = (px, px - nc)
    c0 = max((x for x in cal if x <= lab), default=None)
    if c0 is None:
        continue
    c1 = cal[pos[c0] - 1] if pos[c0] > 0 else None
    st = None
    if w and c0 in sret and c1 in sret:
        m = s_ / w
        e0, e1 = abs(m - sret[c0]), abs(m - sret[c1])
        if min(e0, e1) < 0.003 and abs(e0 - e1) >= 0.0012:
            st = 0 if e0 < e1 else 1
            conf[lab] = abs(e0 - e1)
    status[lab] = [st, c0, c1]


def relation(a, b):
    A, B = big.get(a, {}), big.get(b, {})
    com = [x for x in B if x in A]
    if len(com) < 40:
        return "gap"
    if sorted(abs(B[x][1] / A[x][1] - 1) for x in com)[len(com) // 2] < 0.0002:
        return "same"
    if sorted(abs(B[x][1] / A[x][0] - 1) for x in com)[len(com) // 2] < 0.002:
        return "next"
    return "gap"


# anchor: the first evening whose S&P 500 match is clear; walk the exact links forward (and back to the start) from it
order = [lab for lab in labels if lab in status]
anchor = next((lab for lab in order if lab in conf), order[0])
ai = order.index(anchor)
dated, rels = {}, {"same": 0, "next": 0, "gap": 0}
st0, c0a, c1a = status[anchor]
dated[anchor] = c0a if st0 in (0, None) else c1a
for k in range(ai + 1, len(order)):
    lab, prv = order[k], order[k - 1]
    st, c0, c1 = status[lab]
    r = relation(prv, lab); rels[r] += 1
    pd_ = dated[prv]
    nxt = cal[pos[pd_] + 1] if pos[pd_] + 1 < len(cal) else pd_
    if r == "same":
        dd = pd_
    elif r == "next":
        dd = nxt
    else:   # a broken link (a missing evening): the S&P 500 match decides, otherwise the labelled day
        dd = c1 if st == 1 else c0
        if dd is None or dd <= pd_:
            dd = nxt
    dated[lab] = min(dd, c0)
for k in range(ai - 1, -1, -1):
    lab, nx = order[k], order[k + 1]
    st, c0, c1 = status[lab]
    r = relation(lab, nx); rels[r] += 1
    nd = dated[nx]
    prev_day = cal[pos[nd] - 1] if pos[nd] > 0 else nd
    if r == "same":
        dd = nd
    elif r == "next":
        dd = prev_day
    else:
        dd = c0 if st in (0, None) else c1
        if dd is None or dd >= nd:
            dd = prev_day
    dated[lab] = min(dd, c0)
for lab in order:
    status[lab][0] = 0 if dated[lab] == status[lab][1] else 1
print("anchor evening", anchor, "dated", dated[anchor], flush=True)
chosen = {}
for lab in labels:
    if lab in dated:
        chosen[dated[lab]] = (lab, status[lab][0])     # the later evening wins: it shows the settled close
print("evening-to-evening links:", rels, flush=True)
last_data = max(chosen)
if LAST:
    last_data = min(last_data, LAST)
cal = [x for x in cal if x <= last_data]
T = len(cal)
lagged = sum(1 for v in chosen.values() if v[1] == 1)
print("data days", len(chosen), "| shown a day late", lagged, "| last data day", last_data, "| latest snapshot", labels[-1], "status", status[labels[-1]][0], flush=True)

# ── 4. pass 2: fill arrays
P, R, C, REF, meta = {}, {}, {}, {}, {}
byday = {dd: lab for dd, (lab, st) in chosen.items() if dd <= last_data}
for i, dd in enumerate(cal):
    lab = byday.get(dd)
    if lab is None:
        continue
    rows = read_snapshot(lab, proc)
    for s, (px, nc, pc, cap, name, sec, vol) in rows.items():
        if s not in P:
            P[s] = [math.nan] * T; R[s] = [math.nan] * T; C[s] = [math.nan] * T; REF[s] = [math.nan] * T
        P[s][i] = px; C[s][i] = cap
        R[s][i] = pc if pc is not None else math.nan
        if nc is not None and px - nc > 0:
            REF[s][i] = px - nc
        meta[s] = (name, sec, vol, dd)
    if i % 100 == 0:
        print("  read", i, dd, len(P), flush=True)
proc.stdin.close(); proc.wait()
filled, official = [], 0
for i, dd in enumerate(cal):
    if i + 1 >= T or cal[i + 1] not in byday:
        continue
    gap = dd not in byday
    for s in P:   # the next evening's previous-close column is this day's official close (no after-hours trades in it)
        if not math.isnan(REF[s][i + 1]):
            if gap and math.isnan(P[s][i]):
                C[s][i] = C[s][i + 1]
            if gap or not math.isnan(P[s][i]):
                P[s][i] = REF[s][i + 1]; official += 1
    if gap:
        filled.append(dd)
print("closes taken from the next evening's previous-close column:", official, flush=True)
first_data = min(byday) if byday else cal[0]
missing = [dd for i, dd in enumerate(cal) if dd >= first_data and dd not in byday and dd not in filled]
print("days filled from the next snapshot:", filled, "| days with no data:", missing, flush=True)

if LIVE_AFTER:
    days, metaout = [], {}
    for i, dd in enumerate(cal):
        if dd <= LIVE_AFTER:
            continue
        rows = {}
        for s_, arr in P.items():
            v, cap = arr[i], C[s_][i]
            name = meta[s_][0]
            if math.isnan(v) or math.isnan(cap) or cap < 15e9 or "^" in s_ or ("/" in s_ and s_ != "BRK/B") or BAD_NAME.search(name):
                continue
            pc = R[s_][i]
            rows[s_] = [round(v, 2) if v >= 10 else round(v, 4), None if math.isnan(pc) else round(pc, 2), int(round(cap / 1e9))]
            if cap >= 20e9:
                metaout[s_] = [re.sub(r"\s+(Common Stock|Class A Common Stock|Ordinary Shares|American Depositary Shares)\b.*$", "", name)[:40], meta[s_][1] or "기타"]
        if len(rows) >= 300:
            days.append({"date": dd, "spx": spx.get(dd), "rows": rows})
    out = {"v": 2, "built": datetime.now(timezone.utc).isoformat(timespec="minutes"), "after": LIVE_AFTER, "src": "rreichel3/US-Stock-Symbols (Nasdaq screener) + ravelab/l-etf (S&P 500)",
           "lastSnapshot": labels[-1], "lastStatus": status[labels[-1]][0], "meta": metaout, "days": days}
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(json.dumps({"ok": True, "days": len(days), "first": days[0]["date"] if days else None, "last": days[-1]["date"] if days else None,
                      "lastHasSpx": bool(days and days[-1]["spx"]), "rowsLast": len(days[-1]["rows"]) if days else 0, "bytes": os.path.getsize(OUT)}))
    sys.exit(0)

# ── 5. universe: >= $20B and >= $5 on some day, common-stock names; one series per company (ticker changes merged)
cands = []
for s in P:
    name = meta[s][0]
    if BAD_NAME.search(name) or "^" in s or ("/" in s and s != "BRK/B"):
        continue
    if any(not math.isnan(C[s][i]) and C[s][i] >= CAP_UNIVERSE and P[s][i] >= MIN_PRICE for i in range(T)) and sum(1 for v in P[s] if not math.isnan(v)) >= 40:
        cands.append(s)
WORDS = r"\b(class [a-c]|common stock|capital stock|ordinary shares?|american depositary shares?|subordinate voting shares|inc|corp|corporation|ltd|limited|plc|n ?v|s ?a|holdings?|co|company|the|new)\b"
key = lambda s: " ".join(re.sub(WORDS, " ", re.sub(r"[^a-z0-9& ]", " ", meta[s][0].lower())).split()[:3])
span = lambda s: [i for i in range(T) if not math.isnan(P[s][i])]
groups = {}
for s in cands:
    groups.setdefault(key(s), []).append(s)
uni, merged, dropped = [], [], []
for k, g in groups.items():
    if len(g) == 1:
        uni.append(g[0]); continue
    g.sort(key=lambda s: (span(s)[-1], span(s)[0]))
    newest = g[-1]
    # ticker change: earlier symbols end before the newest starts (allow a few days of overlap)
    seq = all(span(a)[-1] <= span(b)[0] + 3 for a, b in zip(g, g[1:]))
    if seq:
        for old in g[:-1]:
            for i in range(T):
                if math.isnan(P[newest][i]) and not math.isnan(P[old][i]):
                    P[newest][i], R[newest][i], C[newest][i] = P[old][i], R[old][i], C[old][i]
            merged.append(f"{old}->{newest}")
        uni.append(newest)
    else:  # share classes trading side by side: keep the listing with the most dollar volume that is still trading
        best = max(g, key=lambda s: (span(s)[-1], meta[s][2] * P[s][span(s)[-1]]))
        uni.append(best); dropped += [s for s in g if s != best]
uni.sort()
print("universe", len(uni), "| ticker changes merged:", merged, "| other share classes dropped:", dropped, flush=True)

# ── 6. split adjustment
CLEAN = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 10, 1 / 12, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50, 2 / 3, 3 / 2]
syms_out, splits, odd, breaks = [], [], [], []
for s in uni:
    p, r = P[s], R[s]
    ret = [math.nan] * T
    prv = None
    for i in range(T):
        if math.isnan(p[i]):
            continue
        if prv is not None:
            raw = p[i] / p[prv]
            rep = 1 + r[i] / 100 if not math.isnan(r[i]) else math.nan
            f = raw / rep if not math.isnan(rep) else math.nan
            near = min(CLEAN, key=lambda c: abs(f / c - 1)) if not math.isnan(f) else None
            rnear = min(CLEAN, key=lambda c: abs(raw / c - 1))
            if near is not None and abs(f - 1) > 0.15 and abs(f / near - 1) < 0.06:
                ret[i] = rep; splits.append((s, cal[i], round(1 / near, 3)))
            elif abs(math.log(raw)) > math.log(1.8) and abs(raw / rnear - 1) < 0.03:
                # the exchange did not adjust its own % change, but the jump is a clean split ratio
                ret[i] = raw / rnear; splits.append((s, cal[i], round(1 / rnear, 3), "raw"))
            elif not math.isnan(f) and abs(f - 1) > 0.15 and prv < i - 1:
                # a jump across missing days that is not a split: another company took the ticker, start over here
                for j in range(i):
                    p[j] = math.nan
                breaks.append((s, cal[i], round(raw, 3))); ret = [math.nan] * T
            elif math.isnan(rep) and abs(math.log(raw)) > math.log(1.8):
                near = min(CLEAN, key=lambda c: abs(raw / c - 1))
                if abs(raw / near - 1) < 0.25:
                    ret[i] = raw / near; splits.append((s, cal[i], round(1 / near, 3), "no %"))
                else:
                    for j in range(i):
                        p[j] = math.nan
                    breaks.append((s, cal[i], round(raw, 3))); ret = [math.nan] * T
            else:
                if not math.isnan(f) and abs(f - 1) > 0.15:
                    odd.append((s, cal[i], round(raw, 3), round(rep, 3)))
                ret[i] = raw
        prv = i
    adj = [math.nan] * T
    if all(math.isnan(v) for v in p):
        continue
    last = max(i for i in range(T) if not math.isnan(p[i]))
    adj[last] = p[last]
    nxt = last
    for i in range(last - 1, -1, -1):
        if math.isnan(p[i]):
            continue
        adj[i] = adj[nxt] / ret[nxt]
        nxt = i
    # a one-day move beyond +150% / -60% in a large company is a data fault: drop the history before it
    for i in range(T - 1, 0, -1):
        a = next((j for j in range(i - 1, -1, -1) if not math.isnan(adj[j])), None)
        if a is not None and not math.isnan(adj[i]) and (adj[i] / adj[a] > 2.5 or adj[i] / adj[a] < 0.4):
            breaks.append((s, cal[i], round(adj[i] / adj[a], 3), "extreme"))
            for j in range(i):
                adj[j] = math.nan
            break
    rp = lambda v: None if math.isnan(v) else (round(v, 2) if v >= 10 else round(v, 3))
    elig = "".join("1" if (not math.isnan(C[s][i]) and C[s][i] >= CAP_UNIVERSE and p[i] >= MIN_PRICE) else "0" for i in range(T))
    name, sec = meta[s][0], meta[s][1]
    syms_out.append({"s": s, "n": re.sub(r"\s+(Common Stock|Class A Common Stock|Ordinary Shares|American Depositary Shares)\b.*$", "", name)[:40],
                     "sec": sec or "기타", "c": [rp(v) for v in adj], "e": elig})
print("splits:", len(splits), splits, flush=True)
print("large price/%-change disagreements kept as official closes:", len(odd), odd[:40], flush=True)
print("series restarted (ticker reuse or data fault):", breaks, flush=True)
seed = {"v": 2, "built": datetime.now(timezone.utc).isoformat(timespec="minutes"), "src": "rreichel3/US-Stock-Symbols (Nasdaq screener) + ravelab/l-etf (S&P 500)",
        "dates": cal, "spx": [spx.get(x) for x in cal], "lagged": lagged, "filledDays": filled, "missingDays": missing, "excl": dropped,
        "lastSnapshot": labels[-1], "lastStatus": status[labels[-1]][0], "syms": syms_out}
with open(OUT, "w") as f:
    json.dump(seed, f, separators=(",", ":"))
print("wrote", OUT, "| days", T, cal[0], "->", cal[-1], "| symbols", len(syms_out), "| bytes", os.path.getsize(OUT), flush=True)
