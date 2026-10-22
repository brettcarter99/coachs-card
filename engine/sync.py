"""Merge a new Claude card, snapshot SharpAI's picks, grade everything, write state.json.

usage: python3 sync.py STATE_JSON [CARD_JSON]
Rules:
  * Published Claude picks are immutable. One Claude pick per game, max engine.MAX_PLAYS per week.
  * SharpAI picks are read from its public card. The first time we see a pick we freeze its
    number, price, units and publish time. A pick that disappears before kickoff is 'withdrawn'
    and does not count. SharpAI's own grading is ignored; both apps are graded here the same way.
  * Grading and CLV use Action Network book 15 once the game is complete.
"""
import json, os, sys
from datetime import datetime, timezone
import engine as E

SHARPAI_STATE = "https://sharpai-coach.brettcarter99.chatgpt.site/api/state"
START_WEEK = 7  # head-to-head begins Week 7, 2026 (SharpAI's ledger reset on Oct 21)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(path, default):
    return json.load(open(path)) if os.path.exists(path) else default


def slim_assessment(a):
    keep = ("gameId", "away", "home", "kickoff", "neutral", "status", "passReason", "market", "modelLineHome",
            "modelTotal", "finalLineHome", "finalTotal", "spreadGap", "totalGap", "researchAdj", "modelErrorLikely", "play")
    out = {k: a[k] for k in keep if k in a}
    if a.get("research"):
        r = a["research"]
        out["research"] = {k: r.get(k) for k in ("qbs", "note", "case", "caseAgainst", "sources", "researchedAt")}
    best = None
    for s in a.get("sides", []):
        if best is None or s["ev"] > best["ev"]:
            best = s
    if best:
        out["bestSide"] = {k: best[k] for k in ("selection", "price", "ev", "pWin", "pPush")}
    return out


def merge_card(state, card):
    season = card["picks"][0]["season"] if card["picks"] else (card["assessments"][0]["season"] if card["assessments"] else None)
    if not card["assessments"]:
        return
    a0 = card["assessments"][0]
    wk = str(a0["week"])
    existing = [p for p in state["picks"] if p["app"] == "claude" and p["season"] == a0["season"] and p["week"] == a0["week"]]
    have_games = {p["gameId"] for p in existing}
    room = max(0, E.MAX_PLAYS - len(existing))
    new = [p for p in card["picks"] if p["gameId"] not in have_games]
    new.sort(key=lambda p: -p["ev"])
    added = []
    for p in new[:room]:
        p["id"] = f"claude:{p['gameId']}:{p['market']}"
        state["picks"].append(p)
        added.append(p["gameId"])
    # keep the latest assessment per game, but games already played keep their earlier record
    old = {a["gameId"]: a for a in state["weeks"].get(wk, {}).get("assessments", [])}
    for a in card["assessments"]:
        s = slim_assessment(a)
        if a["gameId"] in have_games or a["gameId"] in added:
            s["status"] = "play"
            pk = next(p for p in state["picks"] if p["app"] == "claude" and p["gameId"] == a["gameId"])
            s["play"] = {k: pk[k] for k in ("selection", "price", "ev", "pWin", "pPush", "market", "side", "number")}
        elif a.get("status") == "play":
            s["status"] = "pass"
            s.pop("play", None)
            s["passReason"] = f"Qualified, but the weekly limit of {E.MAX_PLAYS} plays was already used."
        old[a["gameId"]] = s
    state["weeks"][wk] = dict(season=a0["season"], week=a0["week"], updatedAt=now_iso(),
                             assessments=sorted(old.values(), key=lambda x: (x.get("kickoff", ""), x["gameId"])))
    state["ratings"] = card.get("ratings")


def snapshot_sharpai(state):
    try:
        s = E.get_json(SHARPAI_STATE, timeout=45)
    except Exception as e:
        state["sharpaiError"] = f"SharpAI card unreachable at {now_iso()}: {e}"
        return
    state.pop("sharpaiError", None)
    live = {}
    for p in s.get("picks", []):
        if p.get("season") != 2026 or (p.get("week") or 0) < START_WEEK or p.get("cohort", "active") != "active":
            continue
        if p.get("market") not in ("spread", "total"):
            continue
        live[f"sharpai:{p['id']}"] = p
    known = {p["id"]: p for p in state["picks"] if p["app"] == "sharpai"}
    now = datetime.now(timezone.utc)
    for pid, p in live.items():
        if pid in known:
            if known[pid].get("status") == "withdrawn":
                known[pid]["status"] = "open"
            continue
        away, home = p["away"], p["home"]
        side = str(p["side"]).lower()
        if p["market"] == "spread" and side not in ("home", "away"):
            side = "home" if str(p["side"]).upper() == home else "away"
        p["side"] = side
        state["picks"].append(dict(
            id=pid, app="sharpai", season=p["season"], week=p["week"], gameId=f"{p['season']}-w{p['week']:02d}-{away.lower()}-{home.lower()}",
            kickoff=p.get("kickoff"), away=away, home=home, market=p["market"], side=p["side"],
            selection=p.get("selection"), number=p["number"], price=p["price"], units=p.get("units", 1),
            ev=p.get("ev"), pWin=p.get("pWin"), case=p.get("footballCase") or p.get("reason", ""),
            caseAgainst=p.get("caseAgainst", ""), publishedAt=p.get("publishedAt"), firstSeenAt=now_iso(), status="open"))
    for pid, p in known.items():
        if pid not in live and p.get("status") == "open":
            ko = datetime.fromisoformat(p["kickoff"].replace("Z", "+00:00")) if p.get("kickoff") else now
            if ko > now:
                p["status"] = "withdrawn"
    state["sharpaiCheckedAt"] = now_iso()


def grade_all(state):
    by_week = {}
    for p in state["picks"]:
        if p.get("status") in ("open",) or ("clv" not in p and p.get("status") in ("won", "lost", "push")):
            by_week.setdefault((p["season"], p["week"]), []).append(p)
    for (season, week), picks in by_week.items():
        try:
            idx = E.game_index(season, week)
        except Exception:
            continue
        for p in picks:
            g = idx.get((p["away"], p["home"]))
            if not g:
                # AN and SharpAI sometimes differ on abbreviations (LA vs LAR)
                alias = {"LAR": "LA", "LA": "LAR", "WSH": "WAS", "WAS": "WSH"}
                g = idx.get((alias.get(p["away"], p["away"]), alias.get(p["home"], p["home"])))
            if not g or g["status"] != "complete":
                continue
            p.update(E.grade_pick(p, g))
            p["gradedAt"] = now_iso()


def main():
    path = sys.argv[1]
    state = load(path, dict(picks=[], weeks={}))
    state.setdefault("picks", [])
    state.setdefault("weeks", {})
    if len(sys.argv) > 2:
        merge_card(state, json.load(open(sys.argv[2])))
    snapshot_sharpai(state)
    grade_all(state)
    state["engine"] = E.ENGINE_VERSION
    state["updatedAt"] = now_iso()
    json.dump(state, open(path, "w"), indent=1)
    c = [p for p in state["picks"] if p["app"] == "claude"]
    s = [p for p in state["picks"] if p["app"] == "sharpai"]
    print(f"claude picks {len(c)} | sharpai picks {len(s)} | graded {sum(1 for p in state['picks'] if p.get('status') in ('won','lost','push'))}")


if __name__ == "__main__":
    main()
