"""Render the head-to-head page: python3 render.py state.json template.html out.html"""
import json, sys

BACKTEST = ("Tested against 2025 and early-2026 closing lines, Claude's ratings alone ran about break-even: "
            "spreads 57-53-3 (-0.8u) and totals 37-34 (-0.2u). That is the expected result, because a closing line "
            "already holds nearly everything public. An edge has to come from getting a better number than the close "
            "and from news the line has not absorbed yet, which is why CLV is the first thing to watch.")

state_path, tpl_path, out_path = sys.argv[1:4]
state = json.load(open(state_path))
state.setdefault("season", 2026)
if state.get("weeks"):
    state.setdefault("currentWeek", max(int(k) for k in state["weeks"]))
state["backtest"] = {"summary": BACKTEST}
blob = json.dumps(state, separators=(",", ":")).replace("</", "<\\/")
html = open(tpl_path).read().replace("/*__STATE__*/", blob)
open(out_path, "w").write(html)
print("wrote", out_path, len(html), "bytes")
