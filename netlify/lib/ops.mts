// The two jobs that change Coach's Card: a research update (from Coach's scheduled runs) and the
// automatic refresh (lines, grading, SharpAI, weekly rollover).
import * as C from "./coach.mts";
import * as S from "./store.mts";

const SEASON = 2026;

async function sharpai(state: C.State) {
  try { return C.snapshotSharpai(state, await C.getJSON(C.SHARPAI_STATE, 40000)); }
  catch (e) { return C.snapshotSharpai(state, null, String(e)); }
}

async function gradeAll(state: C.State) {
  let n = 0;
  for (const [season, week] of C.needsGrading(state)) {
    try { n += C.gradeWeek(state, season, week, await S.weekGames(season, week, true)); } catch { /* try again next refresh */ }
  }
  return n;
}

// Rebuild the week's board. addPicks=false (automatic refresh) never publishes a pick on its own:
// a game that newly clears the bar waits for Coach's next research check-in.
async function board(state: C.State, week: number, research: C.Research, addPicks: boolean) {
  const [hist, games] = await Promise.all([S.history(SEASON, week), S.weekGames(SEASON, week, true)]);
  const rat = C.buildRatings(hist, SEASON, week);
  const card = C.buildCard(games, rat, research, C.nowIso());
  if (!addPicks) {
    const have = new Set(state.picks.filter(p => p.app === "claude" && p.week === week && p.status !== "withdrawn").map(p => p.gameId));
    for (const a of card.assessments) {
      if (a.status === "play" && !have.has(a.gameId)) {
        a.status = "pass"; delete a.play;
        a.passReason = "At current lines this clears the bar. Coach re-checks the news before playing it on the next check-in.";
      }
    }
    card.picks = [];
  }
  return { added: C.mergeCard(state, card, SEASON, week), games };
}

export async function researchUpdate(origin: string, body: any) {
  const state = await S.loadState(origin);
  const week = Number(body.week ?? state.currentWeek);
  if (week !== state.currentWeek) throw new Error(`Research is for week ${week}, but the current week is ${state.currentWeek}.`);
  const research = await S.loadResearch(origin, SEASON, week);
  for (const [gid, entry] of Object.entries(body.entries ?? {})) {
    if (!gid.startsWith(`${SEASON}-w${String(week).padStart(2, "0")}-`)) throw new Error(`Unknown game id ${gid}.`);
    research[gid] = entry;
  }
  await S.saveResearch(SEASON, week, research);
  const pulled = C.applyWithdrawals(state, research);
  const { added } = await board(state, week, research, true);
  if (typeof body.coachNote === "string" && body.coachNote.trim()) state.weeks[String(week)].coachNote = body.coachNote.trim();
  const sharp = await sharpai(state);
  const graded = await gradeAll(state);
  await S.saveState(state);
  return summary(state, week, { added, pulled, sharpai: sharp, graded });
}

export async function refresh(origin: string) {
  const state = await S.loadState(origin);
  let week = state.currentWeek as number;
  const sharp = await sharpai(state);
  const graded = await gradeAll(state);
  // Roll to next week once every game of the current week is final.
  const now = await S.weekGames(SEASON, week, true);
  let rolled = false;
  if (now.length && now.every(g => g.status === "complete") && week < 18) { week += 1; state.currentWeek = week; rolled = true; }
  const research = await S.loadResearch(origin, SEASON, week);
  await board(state, week, research, false);
  await S.saveState(state);
  return summary(state, week, { added: [], pulled: [], sharpai: sharp, graded, rolled });
}

function summary(state: C.State, week: number, extra: Record<string, unknown>) {
  const wk = state.weeks[String(week)] ?? {};
  const open = state.picks.filter(p => p.app === "claude" && p.week === week && p.status !== "withdrawn")
    .map(p => `${p.selection} ${p.price > 0 ? "+" : ""}${p.price} [${p.status}]`);
  const board = (wk.assessments ?? []).map((a: any) => ({ gameId: a.gameId, kickoff: a.kickoff, status: a.status,
    market: a.market ? `${a.home} ${a.market.spreadHome} / ${a.market.total}` : null, coach: `${a.home} ${a.modelLineHome} / ${a.modelTotal}`,
    best: a.bestSide ? `${a.bestSide.selection} ${(a.bestSide.ev * 100).toFixed(1)}%` : null, reason: a.passReason ?? null,
    researchedAt: a.research?.researchedAt ?? null }));
  return { ok: true, week, updatedAt: state.updatedAt, coachPicks: open, ...extra, board };
}
