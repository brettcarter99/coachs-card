"""Merge a new Claude card, grade everything, write state.json.

usage: python3 sync.py STATE_JSON [CARD_JSON] [RESEARCH_JSON]
Rules:
  * Published Claude picks are immutable. One Claude pick per game, max engine.MAX_PLAYS per week.
  * Grading and CLV use Action Network book 15 once the game is complete.
"""
import json, os, sys
from datetime import datetime, timezone
import engine as E

START_WEEK = 7  # Coach's record starts Week 7, 2026


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
    existing = [p for p in state["picks"] if p["app"] == "claude" and p["season"] == a0["season"] and p["week"] == a0["week"]
                and p.get("status") != "withdrawn"]
    have_games = {p["gameId"] for p in existing}
    room = max(0, E.MAX_PLAYS - len(existing))
    new = [p for p in card["picks"] if p["gameId"] not in have_games]
    new.sort(key=lambda p: -p["ev"])
    added = []
    ids = {q["id"] for q in state["picks"]}
    for p in new[:room]:
        pid, n = f"claude:{p['gameId']}:{p['market']}", 2
        while pid in ids:
            pid, n = f"claude:{p['gameId']}:{p['market']}:{n}", n + 1
        p["id"] = pid
        ids.add(pid)
        state["picks"].append(p)
        added.append(p["gameId"])
    # keep the latest assessment per game, but games already played keep their earlier record
    old = {a["gameId"]: a for a in state["weeks"].get(wk, {}).get("assessments", [])}
    for a in card["assessments"]:
        s = slim_assessment(a)
        if a["gameId"] in have_games or a["gameId"] in added:
            s["status"] = "play"
            pk = next(p for p in state["picks"] if p["app"] == "claude" and p["gameId"] == a["gameId"] and p.get("status") != "withdrawn")
            s["play"] = {k: pk[k] for k in ("selection", "price", "ev", "pWin", "pPush", "market", "side", "number")}
        elif a.get("status") == "play":
            s["status"] = "pass"
            s.pop("play", None)
            s["passReason"] = f"Qualified, but the weekly limit of {E.MAX_PLAYS} plays was already used."
        old[a["gameId"]] = s
    state["weeks"][wk] = dict(season=a0["season"], week=a0["week"], updatedAt=now_iso(),
                             assessments=sorted(old.values(), key=lambda x: (x.get("kickoff", ""), x["gameId"])))
    state["ratings"] = card.get("ratings")


def apply_withdrawals(state, research):
    """research[gameId]["withdraw"] = "reason" pulls Coach's open pick in that game, before kickoff only.
    The pick stays in the ledger as withdrawn and is still graded under ifPlayed."""
    now = datetime.now(timezone.utc)
    out = []
    for gid, r in (research or {}).items():
        reason = r.get("withdraw") if isinstance(r, dict) else None
        if not reason:
            continue
        for p in state["picks"]:
            if p["app"] == "claude" and p["gameId"] == gid and p.get("status") == "open":
                ko = datetime.fromisoformat(p["kickoff"].replace("Z", "+00:00"))
                if ko <= now:
                    continue
                p.update(status="withdrawn", withdrawnAt=now_iso(), withdrawReason=str(reason))
                out.append(p["selection"])
    return out


def grade_all(state):
    by_week = {}
    for p in state["picks"]:
        if p.get("status") == "open" or ("clv" not in p and p.get("status") in ("won", "lost", "push")) \
                or (p.get("status") == "withdrawn" and p["app"] == "claude" and "ifPlayed" not in p):
            by_week.setdefault((p["season"], p["week"]), []).append(p)
    for (season, week), picks in by_week.items():
        try:
            idx = E.game_index(season, week)
        except Exception:
            continue
        for p in picks:
            g = idx.get((p["away"], p["home"]))
            if not g:
                # feeds sometimes differ on abbreviations (LA vs LAR)
                alias = {"LAR": "LA", "LA": "LAR", "WSH": "WAS", "WAS": "WSH"}
                g = idx.get((alias.get(p["away"], p["away"]), alias.get(p["home"], p["home"])))
            if not g or g["status"] != "complete":
                continue
            if p.get("status") == "withdrawn":
                p["ifPlayed"] = E.grade_pick(p, g)
            else:
                p.update(E.grade_pick(p, g))
            p["gradedAt"] = now_iso()


def main():
    path = sys.argv[1]
    state = load(path, dict(picks=[], weeks={}))
    state.setdefault("picks", [])
    state.setdefault("weeks", {})
    if len(sys.argv) > 3 and os.path.exists(sys.argv[3]):
        pulled = apply_withdrawals(state, json.load(open(sys.argv[3])))
        if pulled:
            print("withdrawn:", ", ".join(pulled))
    if len(sys.argv) > 2:
        merge_card(state, json.load(open(sys.argv[2])))
    grade_all(state)
    state["engine"] = E.ENGINE_VERSION
    state["updatedAt"] = now_iso()
    json.dump(state, open(path, "w"), indent=1)
    c = [p for p in state["picks"] if p["app"] == "claude"]
    print(f"claude picks {len(c)} | graded {sum(1 for p in state['picks'] if p.get('status') in ('won','lost','push'))}")


if __name__ == "__main__":
    main()
