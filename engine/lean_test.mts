import * as C from "../netlify/lib/coach.mts";

const H = 3600e3, T0 = Date.parse("2026-11-01T10:00:00Z");
const N = 8;
const teams = Array.from({ length: N }, (_, i) => [`A${i}`, `H${i}`]);
// Home edge in Coach's ratings for each game (bigger = Coach likes the home favorite more).
const edge = [6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0];
const R: Record<string, number> = {};
teams.forEach(([a, h], i) => { R[a] = 0; R[h] = edge[i]; });
const rat: C.Ratings = { R, T: Object.fromEntries(Object.keys(R).map(k => [k, 0])), hfa: 0, totBase: 44, n: 100 };
const kickoff = (i: number) => new Date(T0 + (6 + i) * H).toISOString();
const line: number[] = Array(N).fill(-1);
const games = (): C.Game[] => teams.map(([a, h], i) => ({ anId: i, season: 2026, week: 9, start: kickoff(i), status: "scheduled", away: a, home: h,
  neutral: true, gameId: `2026-w09-${a.toLowerCase()}-${h.toLowerCase()}`, spreadHome: line[i], spreadHomePrice: -110, spreadAwayPrice: -110,
  total: 44, overPrice: -110, underPrice: -110 }));
const gid = (i: number) => games()[i].gameId;
// Research: every game checked; only games in `reason` have a cited spread reason (a small adjustment).
const reason = new Set<number>();
const research = (): C.Research => Object.fromEntries(games().map((g, i) => [g.gameId,
  { status: "ok", spreadAdj: reason.has(i) ? 0.5 : 0, totalAdj: 0, explainsGap: true, case: "x", caseAgainst: "y", cancelIf: "z", sources: [] }]));
let extra: C.Research = {};

const state: C.State = { picks: [], weeks: {}, currentWeek: 9 };
const run = (label: string, addPicks: boolean, nowMs: number) => {
  const card = C.buildCard(games(), rat, { ...research(), ...extra }, C.nowIso());
  const ch = C.mergeCard(state, card, 2026, 9, addPicks, nowMs);
  const on = state.picks.filter(C.onCard).map(p => `${p.tier === "lean" ? "LEAN" : "PLAY"} ${p.selection} ${(p.ev * 100).toFixed(1)}%${p.lockedAt ? " L" : ""}`);
  console.log(`\n== ${label}\n   changes ${JSON.stringify(Object.fromEntries(Object.entries(ch).filter(([, v]) => (v as any[]).length)))}\n   card: ${on.join(" | ")}`);
};
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "ok" : "FAIL"}: ${m}`); if (!c) fails++; };
const onCard = () => state.picks.filter(C.onCard);
const plays = () => onCard().filter(p => (p.tier ?? "play") === "play");
const leans = () => onCard().filter(p => p.tier === "lean");
const of = (i: number) => state.picks.filter(p => p.gameId === gid(i));
const evHome = (i: number) => C.buildCard(games(), rat, { ...research(), ...extra }, "").assessments[i].sides.find((s: any) => s.side === "home").ev;
console.log("home EVs at -1:", teams.map((_, i) => (evHome(i) * 100).toFixed(1)).join(" "));

// 1. Only 2 games have a cited reason. Ratings-only edges can't be plays, so leans fill the card to 3.
reason.add(2); reason.add(3);
run("1. research run: 2 games with a reason", true, T0);
ok(plays().length === 2 && plays().every(p => [gid(2), gid(3)].includes(p.gameId)), "only games with a cited reason are plays");
ok(leans().length === 1 && onCard().length === 3, "one lean fills the card to 3");
ok(leans()[0].gameId === gid(0), "the lean is the best remaining side (game 0, highest EV without a reason)");
const a0 = state.weeks["9"].assessments.find((a: any) => a.gameId === gid(0));
ok(a0.status === "lean" && /Lean/.test(a0.passReason), "board labels the lean");
const a1 = state.weeks["9"].assessments.find((a: any) => a.gameId === gid(1));
ok(/cited football reason/.test(a1.passReason), "board explains why a ratings-only edge isn't a play");

// 2. A third game gets a reason: 3 plays, the lean isn't needed.
reason.add(4);
run("2. research run: third game gets a reason", true, T0 + 30 * 60e3);
ok(plays().length === 3 && leans().length === 0, "3 plays, lean comes off");
ok(of(0)[0].status === "off", "the lean is off, not deleted");

// 3. Plenty of plays: cap at 5.
[5, 6, 7, 1].forEach(i => reason.add(i));
run("3. research run: 7 games qualify", true, T0 + 60 * 60e3);
ok(onCard().length === 5 && plays().length === 5, "card capped at 5 plays");
ok(!of(0).some(C.onCard), "game 0 stays off (card full, its pick only comes back as the same side)");

// 4. Lines move against 3 plays: card drops to 2 plays, so leans fill to 3 even on an automatic refresh.
const top = plays().sort((a, b) => b.ev - a.ev).map(p => games().findIndex(g => g.gameId === p.gameId));
[top[0], top[1], top[2]].forEach(i => (line[i] = -8));
run("4. refresh: 3 plays fall below the bar", false, T0 + 90 * 60e3);
ok(plays().length === 2 && onCard().length >= 3, "2 plays left, card still has at least 3 picks");
ok(leans().length === 1, "one lean (from an off pick) fills the card on a refresh");

// 5. Research run: game 6 (has a reason, clears the bar, was blocked by the full card) is a play and takes the lean's slot.
run("5. research run: a new play beats the lean", true, T0 + 100 * 60e3);
ok(plays().length === 3 && leans().length === 0, "play beats lean: 3 plays, lean off");

// 5b. Churn: two plays fall off, so leans fill; a slightly better new side doesn't swap in, a clearly better one does.
reason.delete(7);
const p3 = plays().map(p => games().findIndex(g => g.gameId === p.gameId));
line[p3[0]] = -8; line[p3[1]] = -8;
run("5b. refresh: two plays fall off", false, T0 + 105 * 60e3);
ok(plays().length === 1 && leans().length === 2, "1 play + 2 leans");
const weakest = leans().sort((a, b) => a.ev - b.ev)[0];
const evAt = (i: number, l: number) => { const keep = line[i]; line[i] = l; const e = evHome(i); line[i] = keep; return e; };
let small = NaN, big = NaN;
for (let l = 6; l >= -6; l -= 0.5) { const e = evAt(7, l); if (isNaN(small) && e > weakest.ev && e < weakest.ev + C.LEAN_KEEP) small = l; if (isNaN(big) && e > weakest.ev + C.LEAN_KEEP + 0.005) big = l; }
console.log("   weakest lean", (weakest.ev * 100).toFixed(1), "| game 7 line for small edge", small, "big edge", big);
if (!isNaN(small)) { line[7] = small; run("5c. research run: new side slightly better than the weakest lean", true, T0 + 106 * 60e3);
  ok(leans().some(p => p.id === weakest.id) && !of(7).some(C.onCard), "weakest lean kept (no churn)"); }
else ok(true, "no line gives a small edge here (skipped)");
line[7] = big; run("5d. research run: new side clearly better", true, T0 + 107 * 60e3);
ok(!leans().some(p => p.id === weakest.id) && of(7).some(C.onCard), "clearly better side replaces the weakest lean");

// 6. Lean upgrades: its game gets a reason and clears the bar.
const li = games().findIndex(g => g.gameId === leans()[0].gameId);
line[li] = -1; reason.add(li);
run("6. refresh: the lean's game gets a reason and clears the bar", false, T0 + 110 * 60e3);
ok((of(li).find(C.onCard)?.tier) === "play", "lean upgraded to a play");

// 7. Lock: a lean locks and counts for the week; it can't be swapped after.
for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) line[i] = -8; // everything falls below the bar
run("7. refresh: every play falls off, leans fill to 3", false, T0 + 120 * 60e3);
ok(plays().length === 0 && leans().length === 3, "zero plays: 3 leans");
const firstLean = leans().sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff))[0], fli = games().findIndex(g => g.gameId === firstLean.gameId);
run("8. lock the earliest lean", false, Date.parse(kickoff(fli)) - 59 * 60e3);
ok(!!of(fli).find(C.onCard)?.lockedAt, "lean locked");
line.fill(-1); reason.clear(); [0, 1, 2, 3, 4, 5, 6, 7].forEach(i => reason.add(i));
run("9. research run after the lock: plenty of plays again", true, Date.parse(kickoff(fli)) - 30 * 60e3);
ok(!!of(fli).find(C.onCard)?.lockedAt && of(fli).find(C.onCard)?.tier === "lean", "locked lean stays on the card");
ok(onCard().length <= 5, `card never above 5 (has ${onCard().length})`);
ok(plays().length >= 3 || onCard().length >= 3, "card has at least 3");

// 10. Pulls: a pulled game never gets a lean.
const pullI = games().findIndex((g, i) => i !== fli && Date.parse(kickoff(i)) - 60 * 60e3 > Date.parse(kickoff(fli)) - 30 * 60e3 && of(i).some(C.onCard));
C.applyWithdrawals(state, { [gid(pullI)]: { withdraw: "QB out" } }, Date.parse(kickoff(fli)) - 30 * 60e3);
extra = { [gid(pullI)]: { ...research()[gid(pullI)], withdraw: "QB out" } };
run("10. research run after a pull", true, Date.parse(kickoff(fli)) - 20 * 60e3);
ok(!of(pullI).some(C.onCard), "pulled game gets no pick back");

// 11. Grading leans works the same as plays.
const lp = state.picks.find(p => p.tier === "lean")!, gi = games().findIndex(g => g.gameId === lp.gameId);
const gr = C.gradePick(lp, { ...games()[gi], status: "complete", homePts: 24, awayPts: 17, spreadHome: -3 });
ok(["won", "lost", "push"].includes(gr.status) && typeof gr.clv === "number", "lean grades with result and CLV");
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exitCode = fails ? 1 : 0;
