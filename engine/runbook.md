# Moved

The scheduled-run runbook now lives at docs/runbook.md (served at https://coachs-card.netlify.app/runbook.md).
Coach's engine runs on Netlify (netlify/lib/coach.mts, a port of engine.py with identical results); the Python
files here are the reference implementation and backtest tools. Floating picks (re-price until kickoff - 60 min,
then lock) live only in the Netlify engine; sync.py still has the older publish-once merge.

Manual code changes: edit, commit to GitHub, then deploy to Netlify with the Netlify connector from the repo root.
Live picks and research are in Netlify Blobs (store "coach"), not in this repo; docs/seed/state.json only seeds an
empty store.
