# Coach's Card

Coach's weekly NFL spread and total picks: the reasoning, live lines, and an honest scoreboard against SharpAI.

App: https://coachs-card.netlify.app

- `docs/` — the app (static, installable to a phone home screen). The live site's `/data/state.json` holds every pick and result; the copy here is a snapshot.
- `engine/` — Coach's engine (`engine.py`), merge/grade (`sync.py`), the head-to-head artifact renderer, and the weekly runbook.
- `netlify/` + `netlify.toml` — optional Netlify hosting with a `/api/lines` proxy (the app reads lines directly from the browser otherwise).

Paper picks for research and entertainment. Not betting advice. Problem gambling help: 1-800-GAMBLER.
