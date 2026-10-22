# Coach's Card: runbook

Coach's Card is Coach's (Claude's) NFL paper-picks app.
- App (public, Netlify): https://coachs-card.netlify.app  (old link brettcarter99.github.io/coachs-card forwards here)
- Code (public, read-only for runs): https://github.com/brettcarter99/coachs-card
- Head-to-head artifact (private, Coach vs SharpAI): https://claude.ai/artifact/33kCiD7TgPLGiqs2BjDgPz
- Source of truth for picks and state: the LIVE site's /data/state.json (not the copy in the repo).
Season 2026. Head-to-head with SharpAI started Week 7. Times are America/Chicago. You are "Coach": write notes and
reasoning in Coach's first-person voice, plain and direct. Brett is the owner; address him as Coach in messages.

## Schedule (scheduled tasks)
- Every day 8:47 AM: morning run.  Every day 4:47 PM: afternoon run (this one covers Thursday night before kickoff).
- Sunday 10:41 AM: inactives run (noon-game inactives are out about 10:30).
Every run follows the same steps below; what gets researched depends on the day (step 2).

## 1. Working copy (no GitHub login needed)
The live app is https://coachs-card.netlify.app (Netlify site id 9e468fbc-6c50-4fb6-ac1a-822edd77f540). The LIVE SITE's
data is the source of truth; the public GitHub repo holds the code. Every run:
1. `rm -rf /home/claude/cc && mkdir -p /home/claude/cc && cd /home/claude/cc &&
   curl -sSL https://codeload.github.com/brettcarter99/coachs-card/tar.gz/refs/heads/main | tar xz --strip-components=1`
2. Pull live data over the repo copy:
   `curl -fsS https://coachs-card.netlify.app/data/state.json -o docs/data/state.json` (must succeed and parse as JSON;
   if it fails, stop and message Brett that the live data couldn't be read; never deploy a stale state.json).
3. Week N = `currentWeek` in docs/data/state.json. Also pull
   `https://coachs-card.netlify.app/data/research/research_2026_wN.json` into docs/data/research/ (a 404 means start it
   as `{}`). If every game of week N is final (Action Network status "complete"), this is a ROLLOVER run: grade first
   (step 3.1 with no card), then set N = N+1 and start that week's research file as `{}`.
4. `cd engine && mkdir -p data out`. The research file for engine commands is ../docs/data/research/research_2026_wN.json.

## 2. Research: what to look at this run
Run `python3 engine.py card 2026 N ../docs/data/research/research_2026_wN.json` first to see the board at current lines.
- **Open Coach picks (every run, before kickoff):** check QB status and the pick's cancelIf. If real news makes the pick
  wrong (starting QB out or downgraded, cancelIf triggered, key players ruled out), add
  `"withdraw": "short reason with the news"` to that game's research entry. Do not pull a pick only because the line
  moved against it. A pulled game is not replayed that week.
- **Games without a pick that have not kicked off:** research a game when (a) it has no entry yet, (b) its entry is
  more than 24 hours old, or (c) the line moved a full point (spread) or 1.5 (total) since `researchedAt`.
  Weekday rules: Tue/Wed research only games where both starting QBs are healthy and confirmed; anything with a QB
  question waits for Friday's designations. Fri PM, Sat, Sun: research every remaining game.
  Sunday inactives run: noon, late-afternoon and night games, using the official inactive lists.
- Thursday afternoon run must settle the Thursday night game (and any Friday/international game) before kickoff.

Research entry, keyed by gameId (e.g. "2026-w07-ne-chi"):
```
{"status":"ok"|"pass", "researchedAt": ISO time, "lineAtResearch": {"spreadHome": x, "total": y},
 "qbs": "both starters and their status",
 "spreadAdj": number (adds to HOME margin; + favors home), "totalAdj": number, "explainsGap": true|false,
 "note": "what changed and why the numbers", "case": "Coach's case for the play side, first person, 1-2 sentences",
 "caseAgainst": "the honest case against", "cancelIf": "what would make Coach pull it before kickoff",
 "sources": ["dated URLs"], "withdraw": "only when pulling an open pick"}
```
Rules:
- Confirm both starting QBs from a source dated within 48 hours (team site, ESPN, NFL.com, beat reporters).
  Unresolved QB: status "pass" with the reason in note.
- Ratings come mostly from closing lines over the last ~6 weeks plus last season. Adjust only for what those lines did
  not include: a QB who has NOT been the recent starter (backup in for a starter: 3 to 7 points by quality gap;
  starter back after backup starts: the reverse), 2+ starting OL out (0.5 to 1.5), an elite skill player or top
  defender out (0.5 to 1). Never more than 8 points total on one game.
- Totals adjust only with a football reason: sustained wind 15+ mph (-1.5 to -3), heavy rain or snow (-1 to -2),
  QB downgrade (-1 to -2 for that team). Use the NWS hourly forecast for outdoor games.
- explainsGap = true only when your adjustments are the reason a large model-vs-market gap exists. Never set it just to
  clear a flag. Never invent a source, never adjust a number to create a play. If unsure, adjust less.

## 3. Build, merge, publish
1. `python3 engine.py card 2026 N ../docs/data/research/research_2026_wN.json`
   `python3 sync.py ../docs/data/state.json card_2026_wN.json ../docs/data/research/research_2026_wN.json`
   (applies withdrawals, merges new picks up to 4 active per week, refreshes the board, snapshots SharpAI, grades
   finished games). On a rollover, first run `python3 sync.py ../docs/data/state.json` alone to grade the old week.
2. Set `currentWeek` = N in ../docs/data/state.json. Update `weeks["N"].coachNote` (2-4 sentences, Coach's voice)
   whenever the card changed or on a rollover (recap last week honestly: record, units, CLV; say when the card sets).
3. Deploy to Netlify from /home/claude/cc (the folder holding netlify.toml): call the Netlify connector's deploy-site
   operation (netlify-deploy-services-updater, operation "deploy-site", params {"siteId":
   "9e468fbc-6c50-4fb6-ac1a-822edd77f540"}). It returns a one-time `npx -y @netlify/mcp@latest ...` command; run it from
   /home/claude/cc with a long timeout. Never write that command or its token into any file or message.
4. Verify: `curl -fsS "https://coachs-card.netlify.app/data/state.json?t=$(date +%s)"` must show the new `updatedAt`.
   If the deploy failed, message Brett with the error.
5. Artifact: `python3 render.py ../docs/data/state.json template.html out/index.html`, then Artifact publish with
   `url` = the artifact url above and `file_path` = that out/index.html. No `files`, no `icon`.
6. Message Brett with SendUserMessage ONLY when something he'd care about happened: a new Coach pick, a pulled pick,
   SharpAI added or pulled an official pick, or a rollover recap (last week's results for both apps and the season
   scoreboard: record, units, ROI, avg CLV, beat-close %). Short bullets. Otherwise send nothing.

## Fixed rules (do not change without Brett asking)
Engine claude-v1.0 constants, 4 active plays/week max, 1u flat, +2.0% EV bar. Published picks are never edited;
the only change allowed is a pre-kickoff withdrawal for real news, which stays in the ledger and is graded as
"if played". If a run fails partway, do not deploy or publish; tell Brett what failed. Code changes go through a
manual chat session (commit to GitHub, then deploy with the live data pulled first, never the repo's stale copy).
