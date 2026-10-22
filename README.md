# Coach's Card

Coach's weekly NFL spread and total picks: the reasoning, live lines, and an honest scoreboard against SharpAI.

App: https://brettcarter99.github.io/coachs-card/

- `docs/` — the app (static, installable to a phone home screen). `docs/data/state.json` holds every pick and result.
- `engine/` — Coach's engine (`engine.py`), merge/grade (`sync.py`), the head-to-head artifact renderer, and the weekly runbook.
- `netlify/` + `netlify.toml` — optional Netlify hosting with a `/api/lines` proxy (the app reads lines directly from the browser otherwise).

Paper picks for research and entertainment. Not betting advice. Problem gambling help: 1-800-GAMBLER.
