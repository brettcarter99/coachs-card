"""Claude's NFL engine (spreads and totals).

Design, in one paragraph:
  1. Team strength comes from two ridge regressions, fit with recency weights over
     last season and this season: one on Action Network book 15 CLOSING lines
     (what the market believed) and one on actual results, with blowout margins capped.
     Blend: 65% market-derived, 35% results-derived. Totals use the same structure.
  2. Claude's research adds only cited, game-specific adjustments (QB changes,
     multiple starters out, weather). No research on a game -> that game cannot publish.
  3. The model line is shrunk toward the current market line (k = 0.40), because
     the market is right far more often than any single model.
  4. Probabilities use a discrete margin distribution with NFL key numbers
     (3, 7, 10, 6, 4, 14 ...), so +3 vs +2.5 is valued correctly. Totals use a
     discretized normal with light key-number mass.
  5. Totals only publish with a cited research adjustment (backtest showed no rating-only
     totals edge). A play needs EV >= 2.0% at the actual price, one market per game, max 4 per week,
     flat 1 unit. A game whose raw model gap is huge (spread > 6.5, total > 8) with no
     research explanation is passed as "Model error likely".
CLV: percentage points of win probability vs the book 15 closing line and price, with number moves
(e.g. +3 vs +2.5) valued through the same key-number distribution. Zero = bet at the closing number and price.
"""
import json, math, os, sys, glob, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
ENGINE_VERSION = "claude-v1.0"
BOOK = "15"

# ---------- tunable constants (fixed once published; changes get a new ENGINE_VERSION) ----------
W_MARKET = 0.65          # market-derived vs results-derived ratings (spreads)
W_MARKET_TOTAL = 0.65    # same, totals
MIN_EV_TOTAL = 0.020
SHRINK_K = 0.40          # share of (model - market) gap kept
SPREAD_SD = 12.6        # residual SD of final margin vs closing spread, 2022-2026 (907 games)
TOTAL_SD = 12.9         # residual SD of final total vs closing total, same sample
MARGIN_CAP = 20.0
PRIOR_SEASON_WEIGHT = 0.30
HALF_LIFE_WEEKS = 6.0
RIDGE = 1.0
MIN_EV = 0.020
MAX_PLAYS = 4
SPREAD_CHECK = 6.5
TOTAL_CHECK = 8.0

# relative frequency multipliers for final margins (NFL key numbers)
# empirical (observed / normal-expected) frequency of final margins, 2022-2026, lightly smoothed
KEY = {0: 0.08, 1: 0.9, 2: 1.0, 3: 2.6, 4: 0.97, 5: 1.0, 6: 1.3, 7: 1.75, 8: 0.9, 9: 0.45, 10: 1.0, 11: 0.5, 12: 0.65, 13: 0.65, 14: 1.2, 15: 0.55, 16: 0.7, 17: 1.5, 18: 0.85, 19: 0.65, 20: 0.9, 21: 1.15}
TOTAL_KEY = {30: 1.3, 32: 0.65, 33: 1.15, 34: 1.15, 37: 1.2, 38: 0.8, 39: 0.9, 41: 1.1, 42: 0.7, 43: 1.05, 45: 0.8, 46: 0.9, 50: 0.65, 51: 1.2, 52: 0.8, 53: 0.7, 56: 0.7, 57: 1.3}

UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def get_json(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def an_path(season, week):
    return os.path.join(DATA, f"an_{season}_w{week}.json")


def fetch_an(season, week, force=False):
    os.makedirs(DATA, exist_ok=True)
    p = an_path(season, week)
    if force or not os.path.exists(p):
        d = get_json(f"https://api.actionnetwork.com/web/v2/scoreboard/publicbetting/nfl?week={week}&season={season}")
        json.dump(d, open(p, "w"))
    return json.load(open(p))


def fetch_espn(season, week, force=False):
    p = os.path.join(DATA, f"espn_{season}_w{week}.json")
    if force or not os.path.exists(p):
        d = get_json(f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week={week}&dates={season}")
        json.dump(d, open(p, "w"))
    return json.load(open(p))


ESPN_TO_AN = {"WSH": "WAS", "LAR": "LA"}


def neutral_pairs(season, week):
    try:
        e = fetch_espn(season, week)
    except Exception:
        return set()
    out = set()
    for ev in e.get("events", []):
        c = ev["competitions"][0]
        if c.get("neutralSite"):
            ab = {x["homeAway"]: ESPN_TO_AN.get(x["team"]["abbreviation"], x["team"]["abbreviation"]) for x in c["competitors"]}
            out.add((ab["away"], ab["home"]))
    return out


def parse_games(an, season, week, neutral=frozenset()):
    games = []
    for g in an.get("games", []):
        t = {x["id"]: x["abbr"] for x in g["teams"]}
        away, home = t[g["away_team_id"]], t[g["home_team_id"]]
        m = g.get("markets", {}).get(BOOK, {}).get("event", {})
        row = dict(anId=g["id"], season=season, week=week, start=g["start_time"], status=g["status"],
                   away=away, home=home, neutral=(away, home) in neutral,
                   gameId=f"{season}-w{week:02d}-{away.lower()}-{home.lower()}")
        for o in m.get("spread", []):
            if o["side"] == "home":
                row["spreadHome"], row["spreadHomePrice"] = o["value"], o["odds"]
            else:
                row["spreadAwayPrice"] = o["odds"]
        for o in m.get("total", []):
            row["total"] = o["value"]
            row["overPrice" if o["side"] == "over" else "underPrice"] = o["odds"]
        b = g.get("boxscore") or {}
        if g["status"] == "complete" and "total_home_points" in b:
            row["homePts"], row["awayPts"] = b["total_home_points"], b["total_away_points"]
        games.append(row)
    return games


def load_history(season, week):
    """All completed games before (season, week): last season + this season."""
    hist = []
    for w in range(1, 19):
        p = an_path(season - 1, w)
        if os.path.exists(p) or True:
            try:
                hist += parse_games(fetch_an(season - 1, w), season - 1, w)
            except Exception:
                pass
    for w in range(1, week):
        hist += parse_games(fetch_an(season, w), season, w, neutral_pairs(season, w))
    return [h for h in hist if "homePts" in h and "spreadHome" in h and "total" in h]


def weight(h, season, week):
    if h["season"] < season:
        age = (18 - h["week"]) + week
        return PRIOR_SEASON_WEIGHT * 0.5 ** (age / (HALF_LIFE_WEEKS * 2))
    return 0.5 ** ((week - h["week"]) / HALF_LIFE_WEEKS)


def ridge_fit(rows, teams, target, season, week):
    """target(h) -> value; model value = c*hfa_flag + r_home - r_away (or + for totals)."""
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    X, y, wts = [], [], []
    for h in rows:
        v = target(h)
        if v is None:
            continue
        x = np.zeros(n + 1)
        x[idx[h["home"]]] += 1
        x[idx[h["away"]]] += h["_sign"]
        x[n] = 0.0 if h["neutral"] else 1.0
        X.append(x); y.append(v); wts.append(weight(h, season, week))
    X, y, W = np.array(X), np.array(y), np.diag(wts)
    pen = np.eye(n + 1) * RIDGE
    pen[n, n] = 0.01
    beta = np.linalg.solve(X.T @ W @ X + pen, X.T @ W @ y)
    return {t: beta[idx[t]] for t in teams}, beta[n]


def build_ratings(season, week):
    hist = load_history(season, week)
    teams = sorted({h["home"] for h in hist} | {h["away"] for h in hist})
    for h in hist:
        h["_sign"] = -1.0
    mkt_sp, mkt_hfa = ridge_fit(hist, teams, lambda h: -h["spreadHome"], season, week)
    res_sp, res_hfa = ridge_fit(hist, teams, lambda h: max(-MARGIN_CAP, min(MARGIN_CAP, h["homePts"] - h["awayPts"])), season, week)
    # totals: value = mean + t_home + t_away (+ tiny home flag)
    mean_tot = np.average([h["total"] for h in hist], weights=[weight(h, season, week) for h in hist])
    for h in hist:
        h["_sign"] = 1.0
    mkt_t, _ = ridge_fit(hist, teams, lambda h: h["total"] - mean_tot, season, week)
    mean_act = np.average([h["homePts"] + h["awayPts"] for h in hist], weights=[weight(h, season, week) for h in hist])
    res_t, _ = ridge_fit(hist, teams, lambda h: max(-24, min(24, h["homePts"] + h["awayPts"] - mean_act)), season, week)
    R = {t: W_MARKET * mkt_sp[t] + (1 - W_MARKET) * res_sp[t] for t in teams}
    T = {t: W_MARKET_TOTAL * mkt_t[t] + (1 - W_MARKET_TOTAL) * res_t[t] for t in teams}
    hfa = W_MARKET * mkt_hfa + (1 - W_MARKET) * res_hfa
    tot_base = W_MARKET_TOTAL * mean_tot + (1 - W_MARKET_TOTAL) * mean_act
    return dict(R=R, T=T, hfa=float(hfa), totBase=float(tot_base), n=len(hist))


# ---------- probability ----------
def _norm_pmf_int(mu, sd, lo, hi):
    ks = np.arange(lo, hi + 1)
    cdf = lambda x: 0.5 * (1 + np.vectorize(math.erf)((x - mu) / (sd * math.sqrt(2))))
    return ks, cdf(ks + 0.5) - cdf(ks - 0.5)


def margin_pmf(mu):
    ks, p = _norm_pmf_int(mu, SPREAD_SD, -70, 70)
    mult = np.array([KEY.get(abs(k), 0.85 if abs(k) <= 30 else 1.0) for k in ks])
    p = p * mult
    return ks, p / p.sum()


def total_pmf(mu):
    ks, p = _norm_pmf_int(mu, TOTAL_SD, 0, 130)
    mult = np.array([TOTAL_KEY.get(int(k), 1.0) for k in ks])
    p = p * mult
    return ks, p / p.sum()


def implied(odds):
    return 100 / (odds + 100) if odds > 0 else -odds / (-odds + 100)


def payout(odds):
    return odds / 100 if odds > 0 else 100 / -odds


def side_probs(market, side, number, mean):
    """P(win), P(push) for a bet. spread: number is the bet side's handicap; mean is home margin."""
    if market == "spread":
        ks, p = margin_pmf(mean)
        diff = ks + number if side == "home" else -ks + number  # bet side's margin + handicap
    else:
        ks, p = total_pmf(mean)
        diff = ks - number if side == "over" else number - ks
    return float(p[diff > 0].sum()), float(p[diff == 0].sum())


def ev(pw, pp, odds):
    return pw * payout(odds) - (1 - pw - pp)


def fair_mean(market, line, p_side_a_price, p_side_b_price):
    """Market-implied mean from line + devigged prices (home/over side = a)."""
    a, b = implied(p_side_a_price), implied(p_side_b_price)
    target = a / (a + b)
    lo, hi = -40.0, 40.0
    base = -line if market == "spread" else line
    lo, hi = base - 10, base + 10
    for _ in range(60):
        mid = (lo + hi) / 2
        if market == "spread":
            pw, pp = side_probs("spread", "home", line, mid)
        else:
            pw, pp = side_probs("total", "over", line, mid)
        q = pw / max(1e-9, 1 - pp)
        if q < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


# ---------- assessment ----------
def assess_game(g, rat, research):
    R, T = rat["R"], rat["T"]
    out = dict(gameId=g["gameId"], anId=g["anId"], season=g["season"], week=g["week"], kickoff=g["start"],
               away=g["away"], home=g["home"], neutral=g["neutral"], engine=ENGINE_VERSION)
    if "spreadHome" not in g or "total" not in g:
        out.update(status="pass", passReason="No book 15 line yet.")
        return out, []
    rs = research.get(g["gameId"])
    adj_sp = float(rs.get("spreadAdj", 0)) if rs else 0.0
    adj_tot = float(rs.get("totalAdj", 0)) if rs else 0.0
    raw_margin = (0 if g["neutral"] else rat["hfa"]) + R.get(g["home"], 0) - R.get(g["away"], 0)
    raw_total = rat["totBase"] + T.get(g["home"], 0) + T.get(g["away"], 0)
    model_margin, model_total = raw_margin + adj_sp, raw_total + adj_tot
    mkt_margin = fair_mean("spread", g["spreadHome"], g["spreadHomePrice"], g["spreadAwayPrice"])
    mkt_total = fair_mean("total", g["total"], g["overPrice"], g["underPrice"])
    fm = mkt_margin + SHRINK_K * (model_margin - mkt_margin)
    ft = mkt_total + SHRINK_K * (model_total - mkt_total)
    out.update(market=dict(spreadHome=g["spreadHome"], spreadHomePrice=g["spreadHomePrice"], spreadAwayPrice=g["spreadAwayPrice"],
                           total=g["total"], overPrice=g["overPrice"], underPrice=g["underPrice"]),
               modelLineHome=round(-model_margin, 1), modelTotal=round(model_total, 1),
               marketFairHome=round(-mkt_margin, 1), marketFairTotal=round(mkt_total, 1),
               finalLineHome=round(-fm, 1), finalTotal=round(ft, 1),
               spreadGap=round(model_margin - mkt_margin, 1), totalGap=round(model_total - mkt_total, 1),
               researchAdj=dict(spread=adj_sp, total=adj_tot))
    cands = []
    for market, sides, mean in (("spread", ("home", "away"), fm), ("total", ("over", "under"), ft)):
        for s in sides:
            if market == "spread":
                num = g["spreadHome"] if s == "home" else -g["spreadHome"]
                price = g["spreadHomePrice"] if s == "home" else g["spreadAwayPrice"]
                team = g[s]
                sel = f"{team} {num:+g}" if num else f"{team} PK"
            else:
                num = g["total"]
                price = g["overPrice"] if s == "over" else g["underPrice"]
                sel = f"{s.upper()} {num:g}"
            pw, pp = side_probs(market, s, num, mean)
            e = ev(pw, pp, price)
            cands.append(dict(market=market, side=s, number=num, price=price, selection=sel,
                              pWin=round(pw, 4), pPush=round(pp, 4), ev=round(e, 4)))
    out["sides"] = cands
    flags = []
    if abs(model_margin - mkt_margin) > SPREAD_CHECK:
        flags.append("spread")
    if abs(model_total - mkt_total) > TOTAL_CHECK:
        flags.append("total")
    if rs and rs.get("withdraw"):
        out.update(status="pass", passReason=f"Pulled before kickoff: {rs['withdraw']}", research=rs)
        return out, []
    if not rs or rs.get("status") != "ok":
        out.update(status="pending" if not rs else "pass",
                   passReason=(rs or {}).get("note") or "Research not complete (QBs and key injuries unconfirmed).")
        return out, []
    out["research"] = rs
    elig = [c for c in cands if c["ev"] >= (MIN_EV if c["market"] == "spread" else MIN_EV_TOTAL)
            and not (c["market"] in flags and not rs.get("explainsGap"))
            and (c["market"] == "spread" or adj_tot != 0)]  # totals need a cited football reason
    if flags and not rs.get("explainsGap"):
        out["modelErrorLikely"] = flags
    if not elig:
        best = max(cands, key=lambda c: c["ev"])
        why = f"Best side {best['selection']} at {best['price']:+d}: EV {best['ev']*100:.1f}%, below the 2.0% bar."
        if best["market"] == "total" and best["ev"] >= MIN_EV_TOTAL and adj_tot == 0:
            sp = max((c for c in cands if c["market"] == "spread"), key=lambda c: c["ev"])
            why = (f"{best['selection']} rates +{best['ev']*100:.1f}% EV on ratings alone, but totals need a cited football reason "
                   f"(ratings-only totals showed no edge in testing). Best spread {sp['selection']}: EV {sp['ev']*100:.1f}%.")
        if flags and not rs.get("explainsGap"):
            why = f"Model error likely ({', '.join(flags)} gap too large with no news to explain it). " + why
        out.update(status="pass", passReason=why)
        return out, []
    best = max(elig, key=lambda c: c["ev"])
    best["finalMean"] = round(fm if best["market"] == "spread" else ft, 2)
    best["playable"] = playable(best["market"], best["side"], best["number"], best["finalMean"])
    out.update(status="play", play=best)
    return out, [best]


def playable(market, side, number, mean):
    """Worst number/price that still clears the EV bar. rows: [{number, minOdds}] from the published number
    down to one point worse; minOdds is American odds (bet is still good at that price or better)."""
    better_high = market == "spread" or side == "under"
    bar = MIN_EV if market == "spread" else MIN_EV_TOTAL
    rows = []
    for k in range(3):
        num = number - 0.5 * k if better_high else number + 0.5 * k
        pw, pp = side_probs(market, side, num, mean)
        if pw <= 0:
            continue
        b = (bar + 1 - pw - pp) / pw  # needed profit per unit staked
        if b > 1.5:  # would need better than +150: not a realistic play
            break
        odds = round(b * 100) if b >= 1 else round(-100 / b)
        rows.append(dict(number=num, minOdds=odds))
    return dict(betterIsHigher=better_high, rows=rows)


def build_card(season, week, research, now_iso):
    rat = build_ratings(season, week)
    games = parse_games(fetch_an(season, week, force=True), season, week, neutral_pairs(season, week))
    assess, plays = [], []
    for g in games:
        if g["status"] != "scheduled":
            continue
        a, p = assess_game(g, rat, research)
        assess.append(a)
        if p:
            plays.append((a, p[0]))
    plays.sort(key=lambda x: -x[1]["ev"])
    keep = plays[:MAX_PLAYS]
    for a, p in plays[MAX_PLAYS:]:
        a.update(status="pass", passReason=f"Cut by the {MAX_PLAYS}-play weekly limit (EV {p['ev']*100:.1f}%).")
        a.pop("play", None)
    picks = []
    for a, p in keep:
        rs = a["research"]
        picks.append(dict(app="claude", season=season, week=week, gameId=a["gameId"], anId=a["anId"], kickoff=a["kickoff"],
                          away=a["away"], home=a["home"], market=p["market"], side=p["side"], selection=p["selection"],
                          number=p["number"], price=p["price"], units=1.0, pWin=p["pWin"], pPush=p["pPush"], ev=p["ev"],
                          modelLine=(a["modelLineHome"] if p["market"] == "spread" else a["modelTotal"]),
                          marketLine=(a["market"]["spreadHome"] if p["market"] == "spread" else a["market"]["total"]),
                          case=rs.get("case", ""), caseAgainst=rs.get("caseAgainst", ""), cancelIf=rs.get("cancelIf", ""),
                          sources=rs.get("sources", []), finalMean=p["finalMean"], playable=p["playable"],
                          engine=ENGINE_VERSION, publishedAt=now_iso, status="open"))
    return dict(ratings=dict(hfa=round(rat["hfa"], 2), totBase=round(rat["totBase"], 1), games=rat["n"],
                             R={k: round(v, 2) for k, v in sorted(rat["R"].items(), key=lambda kv: -kv[1])}),
                assessments=assess, picks=picks)


# ---------- grading / CLV ----------
def grade_pick(p, g):
    """p: pick dict (market, side, number, price). g: parsed completed game with closing line + score."""
    out = {}
    if "homePts" in g:
        hm, aw = g["homePts"], g["awayPts"]
        if p["market"] == "spread":
            m = (hm - aw) if p["side"] == "home" else (aw - hm)
            d = m + p["number"]
        else:
            d = (hm + aw - p["number"]) if p["side"] == "over" else (p["number"] - hm - aw)
        res = "won" if d > 0 else "lost" if d < 0 else "push"
        u = p.get("units", 1.0)
        out.update(status=res, finalScore=f"{p['away']} {aw} - {p['home']} {hm}",
                   unitsResult=round(u * payout(p["price"]) if res == "won" else (-u if res == "lost" else 0.0), 3))
    if "spreadHome" in g and "total" in g:
        if p["market"] == "spread":
            close_num = g["spreadHome"] if p["side"] == "home" else -g["spreadHome"]
            close_price = g["spreadHomePrice"] if p["side"] == "home" else g["spreadAwayPrice"]
            mean = fair_mean("spread", g["spreadHome"], g["spreadHomePrice"], g["spreadAwayPrice"])
        else:
            close_num = g["total"]
            close_price = g["overPrice"] if p["side"] == "over" else g["underPrice"]
            mean = fair_mean("total", g["total"], g["overPrice"], g["underPrice"])
        # CLV in percentage points of win probability: the close's own implied probability, shifted by how much
        # better or worse our number is than the closing number (key-number aware), minus our price's implied probability.
        def q(num):
            pw, pp = side_probs(p["market"], p["side"], num, mean)
            return pw / max(1e-9, 1 - pp)
        q_eq = implied(close_price) + (q(p["number"]) - q(close_num))
        clv = (q_eq - implied(p["price"])) * 100
        out.update(closeNumber=close_num, closePrice=close_price, clv=round(clv, 2), beatClose=bool(clv > 0.05))
    return out


def game_index(season, week):
    games = parse_games(fetch_an(season, week, force=True), season, week, neutral_pairs(season, week))
    return {(g["away"], g["home"]): g for g in games}


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "card":
        season, week = int(sys.argv[2]), int(sys.argv[3])
        research = json.load(open(sys.argv[4])) if len(sys.argv) > 4 and os.path.exists(sys.argv[4]) else {}
        from datetime import datetime, timezone
        card = build_card(season, week, research, datetime.now(timezone.utc).isoformat(timespec="seconds"))
        json.dump(card, open(os.path.join(HERE, f"card_{season}_w{week}.json"), "w"), indent=1)
        for a in card["assessments"]:
            print(f"{a['away']:>3} @ {a['home']:<3} mkt {a.get('market',{}).get('spreadHome','-'):>5} model {a.get('modelLineHome','-'):>6} "
                  f"| tot {a.get('market',{}).get('total','-'):>5} model {a.get('modelTotal','-'):>5} | {a['status']}: "
                  f"{a.get('play',{}).get('selection','')} {a.get('play',{}).get('ev','')}")
