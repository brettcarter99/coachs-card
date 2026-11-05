# Coach's Card

Coach's weekly NFL spread and total picks: the reasoning, live lines, and an honest scoreboard.

App: https://coachs-card.netlify.app

- `docs/` — the app (installable to a phone home screen) and `docs/runbook.md`, the research runbook for Coach's scheduled runs.
- `netlify/` — Coach's engine and API on Netlify Functions (`/api/state`, `/api/research`, `/api/refresh`, `/api/lines`) plus a 2-hour scheduled refresh and a 5-minute lock check (picks float with the line until 60 minutes before kickoff, then lock). Live data is in Netlify Blobs.
- `engine/` — Coach's engine (`engine.py`), merge/grade (`sync.py`), and a pointer to the runbook.

Paper picks for research and entertainment. Not betting advice. Problem gambling help: 1-800-GAMBLER.
