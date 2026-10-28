// Coach's engine (claude-v1.1), ported from engine/engine.py and engine/sync.py so it can run on Netlify.
// Keep the constants and logic in step with the Python version; tests/parity compares the two.

export const ENGINE_VERSION = "claude-v1.2";
const BOOK = "15";

export const W_MARKET = 0.65, W_MARKET_TOTAL = 0.65, MIN_EV_TOTAL = 0.02, SHRINK_K = 0.40;
export const SPREAD_SD = 12.6, TOTAL_SD = 12.9, MARGIN_CAP = 20.0, PRIOR_SEASON_WEIGHT = 0.30;
export const HALF_LIFE_WEEKS = 6.0, RIDGE = 1.0, MIN_EV = 0.02, MAX_PLAYS = 5, SPREAD_CHECK = 6.5, TOTAL_CHECK = 8.0;
// The card always carries at least MIN_CARD picks a week. Plays need +2% EV and a cited football reason; when there are
// fewer than MIN_CARD plays, Coach's best remaining researched sides fill the card as "leans", tracked separately.
export const MIN_CARD = 3;
export const LEAN_KEEP = 0.005; // a lean on the card keeps its slot unless a challenger is 0.5% EV better
export const START_WEEK = 7;
// Lean correction (v1.1). Coach's ratings are fit with a pull toward average, so his raw number sits closer to zero
// than the market on big spreads and closer to the league mean on high and low totals. That made nearly every play an
// underdog (164 of 170 in a 2025-26 walk-forward test). The correction removes the part of Coach's disagreement with
// the market that is predictable from the market number alone: gap - (c0 + c1 x market). Fit on 361 games, 2025 weeks
// 2-18 and 2026 weeks 1-7, against Action Network book 15 closing lines; stable across seasons and time of year.
export const TILT_SPREAD = { c0: 0.55, c1: -0.461 };            // market = fair home margin (+ = home favored)
export const TILT_TOTAL = { c0: 0.10, c1: -0.335, center: 45.2 }; // market = fair total
// Coach picks float with the market until this many minutes before kickoff, then lock for good.
export const LOCK_MINUTES = 60;
export const SHARPAI_STATE = "https://sharpai-coach.brettcarter99.chatgpt.site/api/state";

const KEY: Record<number, number> = { 0: 0.08, 1: 0.9, 2: 1.0, 3: 2.6, 4: 0.97, 5: 1.0, 6: 1.3, 7: 1.75, 8: 0.9, 9: 0.45, 10: 1.0, 11: 0.5, 12: 0.65, 13: 0.65, 14: 1.2, 15: 0.55, 16: 0.7, 17: 1.5, 18: 0.85, 19: 0.65, 20: 0.9, 21: 1.15 };
const TOTAL_KEY: Record<number, number> = { 30: 1.3, 32: 0.65, 33: 1.15, 34: 1.15, 37: 1.2, 38: 0.8, 39: 0.9, 41: 1.1, 42: 0.7, 43: 1.05, 45: 0.8, 46: 0.9, 50: 0.65, 51: 1.2, 52: 0.8, 53: 0.7, 56: 0.7, 57: 1.3 };

export type Game = {
  anId: number; season: number; week: number; start: string; status: string; away: string; home: string; neutral: boolean; gameId: string;
  spreadHome?: number; spreadHomePrice?: number; spreadAwayPrice?: number; total?: number; overPrice?: number; underPrice?: number;
  homePts?: number; awayPts?: number;
};
export type Research = Record<string, any>;
export type State = { picks: any[]; weeks: Record<string, any>; [k: string]: any };

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r2 = (x: number) => Math.round(x * 1e2) / 1e2;
const r1 = (x: number) => Math.round(x * 10) / 10;
const fmtG = (n: number) => String(Number(n.toPrecision(6)));
const odds = (p: number) => `${p > 0 ? "+" : ""}${p}`;
const barFor = (market: string) => (market === "spread" ? MIN_EV : MIN_EV_TOTAL);

// ---------- lock ----------
export const lockTime = (p: { kickoff?: string }) => (p.kickoff ? Date.parse(p.kickoff) - LOCK_MINUTES * 60000 : Infinity);
export const isLocked = (p: any, now = Date.now()) => !!p.lockedAt || now >= lockTime(p);
// A Coach pick is on the card unless it was pulled for news or is floating off the card.
export const onCard = (p: any) => p.status !== "withdrawn" && p.status !== "off";

// ---------- data ----------
export async function getJSON(url: string, ms = 20000, tries = 3): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (CoachsCard)", Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return await r.json();
    } catch (e) { last = e; if (i < tries - 1) await new Promise(res => setTimeout(res, 800 * (i + 1))); }
  }
  throw last;
}
export const anUrl = (season: number, week: number) =>
  `https://api.actionnetwork.com/web/v2/scoreboard/publicbetting/nfl?week=${week}&season=${season}`;
export const espnUrl = (season: number, week: number) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`;

const ESPN_TO_AN: Record<string, string> = { WSH: "WAS", LAR: "LA" };
export function neutralPairs(espn: any): Set<string> {
  const out = new Set<string>();
  for (const ev of espn?.events ?? []) {
    const c = ev.competitions[0];
    if (!c.neutralSite) continue;
    const ab: Record<string, string> = {};
    for (const x of c.competitors) ab[x.homeAway] = ESPN_TO_AN[x.team.abbreviation] ?? x.team.abbreviation;
    out.add(`${ab.away}@${ab.home}`);
  }
  return out;
}

export function parseGames(an: any, season: number, week: number, neutral: Set<string> = new Set()): Game[] {
  return (an?.games ?? []).map((g: any) => {
    const t: Record<number, string> = {};
    for (const x of g.teams) t[x.id] = x.abbr;
    const away = t[g.away_team_id], home = t[g.home_team_id];
    const m = g.markets?.[BOOK]?.event ?? {};
    const row: Game = { anId: g.id, season, week, start: g.start_time, status: g.status, away, home,
      neutral: neutral.has(`${away}@${home}`), gameId: `${season}-w${String(week).padStart(2, "0")}-${away.toLowerCase()}-${home.toLowerCase()}` };
    for (const o of m.spread ?? []) { if (o.side === "home") { row.spreadHome = o.value; row.spreadHomePrice = o.odds; } else row.spreadAwayPrice = o.odds; }
    for (const o of m.total ?? []) { row.total = o.value; if (o.side === "over") row.overPrice = o.odds; else row.underPrice = o.odds; }
    const b = g.boxscore ?? {};
    if (g.status === "complete" && typeof b.total_home_points === "number") { row.homePts = b.total_home_points; row.awayPts = b.total_away_points; }
    return row;
  });
}

// ---------- ratings ----------
function weight(h: Game, season: number, week: number) {
  if (h.season < season) { const age = (18 - h.week) + week; return PRIOR_SEASON_WEIGHT * Math.pow(0.5, age / (HALF_LIFE_WEEKS * 2)); }
  return Math.pow(0.5, (week - h.week) / HALF_LIFE_WEEKS);
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

function ridgeFit(rows: Game[], teams: string[], target: (h: Game) => number, sign: number, season: number, week: number) {
  const idx = new Map(teams.map((t, i) => [t, i])), n = teams.length;
  const A = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)), b = new Array(n + 1).fill(0);
  for (const h of rows) {
    const v = target(h), w = weight(h, season, week);
    const x: [number, number][] = [[idx.get(h.home)!, 1], [idx.get(h.away)!, sign]];
    if (!h.neutral) x.push([n, 1]);
    // merge duplicate index (never happens: home != away)
    for (const [i, xi] of x) { b[i] += w * xi * v; for (const [j, xj] of x) A[i][j] += w * xi * xj; }
  }
  for (let i = 0; i < n; i++) A[i][i] += RIDGE;
  A[n][n] += 0.01;
  const beta = solve(A, b);
  const R: Record<string, number> = {};
  teams.forEach((t, i) => (R[t] = beta[i]));
  return { R, c: beta[n] };
}

export type Ratings = { R: Record<string, number>; T: Record<string, number>; hfa: number; totBase: number; n: number };
export function buildRatings(history: Game[], season: number, week: number): Ratings {
  const hist = history.filter(h => h.homePts !== undefined && h.spreadHome !== undefined && h.total !== undefined);
  const teams = [...new Set(hist.flatMap(h => [h.home, h.away]))].sort();
  const mkt = ridgeFit(hist, teams, h => -h.spreadHome!, -1, season, week);
  const res = ridgeFit(hist, teams, h => Math.max(-MARGIN_CAP, Math.min(MARGIN_CAP, h.homePts! - h.awayPts!)), -1, season, week);
  const ws = hist.map(h => weight(h, season, week)), wsum = ws.reduce((a, x) => a + x, 0);
  const meanTot = hist.reduce((a, h, i) => a + ws[i] * h.total!, 0) / wsum;
  const meanAct = hist.reduce((a, h, i) => a + ws[i] * (h.homePts! + h.awayPts!), 0) / wsum;
  const mt = ridgeFit(hist, teams, h => h.total! - meanTot, 1, season, week);
  const rt = ridgeFit(hist, teams, h => Math.max(-24, Math.min(24, h.homePts! + h.awayPts! - meanAct)), 1, season, week);
  const R: Record<string, number> = {}, T: Record<string, number> = {};
  for (const t of teams) { R[t] = W_MARKET * mkt.R[t] + (1 - W_MARKET) * res.R[t]; T[t] = W_MARKET_TOTAL * mt.R[t] + (1 - W_MARKET_TOTAL) * rt.R[t]; }
  return { R, T, hfa: W_MARKET * mkt.c + (1 - W_MARKET) * res.c, totBase: W_MARKET_TOTAL * meanTot + (1 - W_MARKET_TOTAL) * meanAct, n: hist.length };
}

// ---------- probability ----------
function erf(x: number) { // W. J. Cody-style rational approximation via erfc (abs error < 1.2e-7)
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
function normPmfInt(mu: number, sd: number, lo: number, hi: number) {
  const ks: number[] = [], p: number[] = [];
  const cdf = (x: number) => 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));
  for (let k = lo; k <= hi; k++) { ks.push(k); p.push(cdf(k + 0.5) - cdf(k - 0.5)); }
  return { ks, p };
}
function marginPmf(mu: number) {
  const { ks, p } = normPmfInt(mu, SPREAD_SD, -70, 70);
  const q = p.map((v, i) => v * (KEY[Math.abs(ks[i])] ?? (Math.abs(ks[i]) <= 30 ? 0.85 : 1.0)));
  const s = q.reduce((a, x) => a + x, 0);
  return { ks, p: q.map(v => v / s) };
}
function totalPmf(mu: number) {
  const { ks, p } = normPmfInt(mu, TOTAL_SD, 0, 130);
  const q = p.map((v, i) => v * (TOTAL_KEY[ks[i]] ?? 1.0));
  const s = q.reduce((a, x) => a + x, 0);
  return { ks, p: q.map(v => v / s) };
}
export const implied = (o: number) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
export const payout = (o: number) => (o > 0 ? o / 100 : 100 / -o);
export function sideProbs(market: string, side: string, number: number, mean: number): [number, number] {
  const { ks, p } = market === "spread" ? marginPmf(mean) : totalPmf(mean);
  let w = 0, pu = 0;
  ks.forEach((k, i) => {
    const d = market === "spread" ? (side === "home" ? k + number : -k + number) : (side === "over" ? k - number : number - k);
    if (d > 0) w += p[i]; else if (d === 0) pu += p[i];
  });
  return [w, pu];
}
export const ev = (pw: number, pp: number, o: number) => pw * payout(o) - (1 - pw - pp);
export function fairMean(market: string, line: number, a: number, b: number) {
  const ia = implied(a), ib = implied(b), target = ia / (ia + ib);
  const base = market === "spread" ? -line : line;
  let lo = base - 10, hi = base + 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const [pw, pp] = market === "spread" ? sideProbs("spread", "home", line, mid) : sideProbs("total", "over", line, mid);
    const q = pw / Math.max(1e-9, 1 - pp);
    if (q < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function playable(market: string, side: string, number: number, mean: number) {
  const betterHigh = market === "spread" || side === "under";
  const bar = market === "spread" ? MIN_EV : MIN_EV_TOTAL;
  const rows: { number: number; minOdds: number }[] = [];
  for (let k = 0; k < 3; k++) {
    const num = betterHigh ? number - 0.5 * k : number + 0.5 * k;
    const [pw, pp] = sideProbs(market, side, num, mean);
    if (pw <= 0) continue;
    const b = (bar + 1 - pw - pp) / pw;
    if (b > 1.5) break;
    rows.push({ number: num, minOdds: b >= 1 ? Math.round(b * 100) : Math.round(-100 / b) });
  }
  return { betterIsHigher: betterHigh, rows };
}

// ---------- assessment ----------
export function assessGame(g: Game, rat: Ratings, research: Research): [any, any[]] {
  const out: any = { gameId: g.gameId, anId: g.anId, season: g.season, week: g.week, kickoff: g.start, away: g.away, home: g.home, neutral: g.neutral, engine: ENGINE_VERSION };
  if (g.spreadHome === undefined || g.total === undefined) { out.status = "pass"; out.passReason = "No book 15 line yet."; return [out, []]; }
  const rs = research[g.gameId];
  const adjSp = rs ? Number(rs.spreadAdj ?? 0) : 0, adjTot = rs ? Number(rs.totalAdj ?? 0) : 0;
  const rawMargin = (g.neutral ? 0 : rat.hfa) + (rat.R[g.home] ?? 0) - (rat.R[g.away] ?? 0);
  const rawTotal = rat.totBase + (rat.T[g.home] ?? 0) + (rat.T[g.away] ?? 0);
  const mkM = fairMean("spread", g.spreadHome, g.spreadHomePrice!, g.spreadAwayPrice!);
  const mkT = fairMean("total", g.total, g.overPrice!, g.underPrice!);
  const ratM = rawMargin - (TILT_SPREAD.c0 + TILT_SPREAD.c1 * mkM);                     // Coach's number after the lean correction
  const ratT = rawTotal - (TILT_TOTAL.c0 + TILT_TOTAL.c1 * (mkT - TILT_TOTAL.center));
  const mm = ratM + adjSp, mtot = ratT + adjTot;
  const fm = mkM + SHRINK_K * (mm - mkM), ft = mkT + SHRINK_K * (mtot - mkT);
  Object.assign(out, {
    market: { spreadHome: g.spreadHome, spreadHomePrice: g.spreadHomePrice, spreadAwayPrice: g.spreadAwayPrice, total: g.total, overPrice: g.overPrice, underPrice: g.underPrice },
    modelLineHome: r1(-mm), modelTotal: r1(mtot), rawLineHome: r1(-rawMargin), rawTotal: r1(rawTotal), marketFairHome: r1(-mkM), marketFairTotal: r1(mkT),
    finalLineHome: r1(-fm), finalTotal: r1(ft), spreadGap: r1(mm - mkM), totalGap: r1(mtot - mkT), researchAdj: { spread: adjSp, total: adjTot },
  });
  const cands: any[] = [];
  for (const [market, sides, mean] of [["spread", ["home", "away"], fm], ["total", ["over", "under"], ft]] as const) {
    for (const s of sides) {
      let num: number, price: number, sel: string;
      if (market === "spread") {
        num = s === "home" ? g.spreadHome : -g.spreadHome; price = s === "home" ? g.spreadHomePrice! : g.spreadAwayPrice!;
        const team = s === "home" ? g.home : g.away;
        sel = num ? `${team} ${num > 0 ? "+" : ""}${fmtG(num)}` : `${team} PK`;
      } else { num = g.total; price = s === "over" ? g.overPrice! : g.underPrice!; sel = `${s.toUpperCase()} ${fmtG(num)}`; }
      const [pw, pp] = sideProbs(market, s, num, mean);
      cands.push({ market, side: s, number: num, price, selection: sel, pWin: r4(pw), pPush: r4(pp), ev: r4(ev(pw, pp, price)) });
    }
  }
  out.sides = cands;
  out.finalMean = { spread: r2(fm), total: r2(ft) };
  const flags: string[] = [];
  if (Math.abs(mm - mkM) > SPREAD_CHECK) flags.push("spread");
  if (Math.abs(mtot - mkT) > TOTAL_CHECK) flags.push("total");
  if (rs && rs.withdraw) { Object.assign(out, { status: "pass", passReason: `Pulled before kickoff: ${rs.withdraw}`, research: rs }); return [out, []]; }
  if (!rs || rs.status !== "ok") {
    out.status = rs ? "pass" : "pending";
    out.passReason = rs?.note || "Research not complete (QBs and key injuries unconfirmed).";
    return [out, []];
  }
  out.research = rs;
  // A play needs a cited football reason in that market (v1.2): ratings alone showed no edge against the close.
  const reason = (m: string) => (m === "spread" ? adjSp !== 0 : adjTot !== 0);
  const usable = (c: any) => !(flags.includes(c.market) && !rs.explainsGap);
  const elig = cands.filter(c => c.ev >= (c.market === "spread" ? MIN_EV : MIN_EV_TOTAL) && usable(c) && reason(c.market));
  if (flags.length && !rs.explainsGap) out.modelErrorLikely = flags;
  const lc = cands.filter(usable);
  if (lc.length) {
    const lb = lc.reduce((a, c) => (c.ev > a.ev ? c : a));
    out.lean = { ...lb, finalMean: r2(lb.market === "spread" ? fm : ft) };
    out.lean.playable = playable(lb.market, lb.side, lb.number, out.lean.finalMean);
  }
  out.eligible = elig.map(c => `${c.market}:${c.side}`); // sides that may be on the card (a floating pick can come back on)
  if (!elig.length) {
    const best = cands.reduce((a, c) => (c.ev > a.ev ? c : a));
    let why = `Best side ${best.selection} at ${best.price > 0 ? "+" : ""}${best.price}: EV ${(best.ev * 100).toFixed(1)}%, below the 2.0% bar.`;
    if (best.ev >= barFor(best.market) && !reason(best.market)) {
      why = `${best.selection} rates +${(best.ev * 100).toFixed(1)}% EV on ratings alone, but a play needs a cited football reason (ratings alone showed no edge against the closing line in testing).`;
    }
    if (flags.length && !rs.explainsGap) why = `Model error likely (${flags.join(", ")} gap too large with no news to explain it). ` + why;
    out.status = "pass"; out.passReason = why;
    return [out, []];
  }
  const best = elig.reduce((a, c) => (c.ev > a.ev ? c : a));
  best.finalMean = r2(best.market === "spread" ? fm : ft);
  best.playable = playable(best.market, best.side, best.number, best.finalMean);
  out.status = "play"; out.play = best;
  return [out, [best]];
}

export function buildCard(games: Game[], rat: Ratings, research: Research, now: string) {
  const assess: any[] = [], plays: [any, any][] = [];
  for (const g of games) {
    if (g.status !== "scheduled") continue;
    const [a, p] = assessGame(g, rat, research);
    assess.push(a);
    if (p.length) plays.push([a, p[0]]);
  }
  plays.sort((x, y) => y[1].ev - x[1].ev);
  // Every qualifying play is a candidate; mergeCard decides what fits on the card around the picks already there.
  const toPick = ([a, p]: [any, any], tier: "play" | "lean") => {
    const rs = a.research;
    return { app: "claude", tier, season: a.season, week: a.week, gameId: a.gameId, anId: a.anId, kickoff: a.kickoff, away: a.away, home: a.home,
      market: p.market, side: p.side, selection: p.selection, number: p.number, price: p.price, units: 1.0, pWin: p.pWin, pPush: p.pPush, ev: p.ev,
      modelLine: p.market === "spread" ? a.modelLineHome : a.modelTotal, marketLine: p.market === "spread" ? a.market.spreadHome : a.market.total,
      case: rs.case ?? "", caseAgainst: rs.caseAgainst ?? "", cancelIf: rs.cancelIf ?? "", sources: rs.sources ?? [],
      finalMean: p.finalMean, playable: p.playable, engine: ENGINE_VERSION, publishedAt: now, status: "open" };
  };
  const candidates = plays.map(x => toPick(x, "play"));
  const leanCandidates = assess.filter(a => a.status !== "play" && a.lean && a.research && !a.research.withdraw)
    .map(a => toPick([a, a.lean], "lean")).sort((x, y) => y.ev - x.ev);
  for (const [a] of plays) a.qualified = true;
  const R: Record<string, number> = {};
  Object.entries(rat.R).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => (R[k] = r2(v)));
  return { ratings: { hfa: r2(rat.hfa), totBase: r1(rat.totBase), games: rat.n, R }, assessments: assess, candidates, leanCandidates, picks: candidates.slice(0, MAX_PLAYS) };
}

// ---------- grading ----------
export function gradePick(p: any, g: Game) {
  const out: any = {};
  if (g.homePts !== undefined) {
    const hm = g.homePts, aw = g.awayPts!;
    const d = p.market === "spread" ? (p.side === "home" ? hm - aw : aw - hm) + p.number : (p.side === "over" ? hm + aw - p.number : p.number - hm - aw);
    const res = d > 0 ? "won" : d < 0 ? "lost" : "push", u = p.units ?? 1;
    Object.assign(out, { status: res, finalScore: `${p.away} ${aw} - ${p.home} ${hm}`,
      unitsResult: Math.round((res === "won" ? u * payout(p.price) : res === "lost" ? -u : 0) * 1000) / 1000 });
  }
  if (g.spreadHome !== undefined && g.total !== undefined) {
    let cn: number, cp: number, mean: number;
    if (p.market === "spread") {
      cn = p.side === "home" ? g.spreadHome : -g.spreadHome; cp = p.side === "home" ? g.spreadHomePrice! : g.spreadAwayPrice!;
      mean = fairMean("spread", g.spreadHome, g.spreadHomePrice!, g.spreadAwayPrice!);
    } else { cn = g.total; cp = p.side === "over" ? g.overPrice! : g.underPrice!; mean = fairMean("total", g.total, g.overPrice!, g.underPrice!); }
    const q = (num: number) => { const [pw, pp] = sideProbs(p.market, p.side, num, mean); return pw / Math.max(1e-9, 1 - pp); };
    const clvAt = (num: number, price: number) => (implied(cp) + (q(num) - q(cn)) - implied(price)) * 100;
    // Graded at the locked number and price. clvFirst measures the first published number, so early-number skill still shows.
    const clv = clvAt(p.number, p.price);
    Object.assign(out, { closeNumber: cn, closePrice: cp, clv: r2(clv), beatClose: clv > 0.05 });
    if (typeof p.firstNumber === "number") {
      const f = clvAt(p.firstNumber, p.firstPrice ?? p.price);
      Object.assign(out, { clvFirst: r2(f), beatCloseFirst: f > 0.05 });
    }
  }
  return out;
}

// ---------- state merging (sync.py) ----------
function slim(a: any) {
  const keep = ["gameId", "away", "home", "kickoff", "neutral", "status", "passReason", "market", "modelLineHome", "modelTotal", "finalLineHome",
    "finalTotal", "spreadGap", "totalGap", "researchAdj", "modelErrorLikely", "play"];
  const out: any = {};
  for (const k of keep) if (k in a) out[k] = a[k];
  if (a.research) { const r = a.research; out.research = {}; for (const k of ["qbs", "note", "case", "caseAgainst", "sources", "researchedAt"]) out.research[k] = r[k] ?? null; }
  if (a.sides?.length) { const b = a.sides.reduce((x: any, c: any) => (c.ev > x.ev ? c : x)); out.bestSide = { selection: b.selection, price: b.price, ev: b.ev, pWin: b.pWin, pPush: b.pPush }; }
  return out;
}

// ---------- floating picks: audit trail ----------
const tag = (p: any) => `${p.selection} (${odds(p.price)})`;
function ensureAudit(p: any) {
  if (typeof p.firstNumber !== "number") { p.firstNumber = p.number; p.firstPrice = p.price; p.firstEv = p.ev; }
  if (!Array.isArray(p.history)) p.history = [{ at: p.publishedAt ?? nowIso(), event: "posted", number: p.number, price: p.price, ev: p.ev }];
  if (!p.lockAt && p.kickoff) p.lockAt = new Date(lockTime(p)).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
function log(p: any, event: string, at: string) {
  p.history.push({ at, event, number: p.number, price: p.price, ev: p.ev });
}
// Move a pick to the current market number and price for the same side, priced against Coach's number.
function reprice(p: any, a: any, c: any, at: string) {
  const mean = a.finalMean?.[p.market] ?? p.finalMean;
  const moved = p.number !== c.number || p.price !== c.price;
  Object.assign(p, { selection: c.selection, number: c.number, price: c.price, pWin: c.pWin, pPush: c.pPush, ev: c.ev,
    marketLine: p.market === "spread" ? a.market.spreadHome : a.market.total,
    modelLine: p.market === "spread" ? a.modelLineHome : a.modelTotal,
    finalMean: mean, playable: playable(p.market, p.side, c.number, mean), repricedAt: at });
  const rs = a.research;
  if (rs) Object.assign(p, { case: rs.case ?? p.case, caseAgainst: rs.caseAgainst ?? p.caseAgainst, cancelIf: rs.cancelIf ?? p.cancelIf, sources: rs.sources ?? p.sources });
  return moved;
}

export type CardChanges = { added: string[]; back: string[]; off: string[]; moved: string[]; locked: string[]; leans: string[]; upgraded: string[]; bumped: string[] };
const tierOf = (p: any) => p.tier ?? "play";
const lbl = (p: any) => `${tierOf(p) === "lean" ? "Lean " : ""}${tag(p)}`;

// Fold a freshly built card into the state.
// Before lock (kickoff - LOCK_MINUTES) every Coach pick follows the market: it is re-priced at the current number and
// price for its side. A play stays on while it clears the bar with a cited reason and goes "off" when it doesn't; it
// can come back on later that week. When the card has fewer than MIN_CARD picks, Coach's best remaining researched
// sides fill it as leans; a new play bumps an unlocked lean when the card is full (MAX_PLAYS). At lock, picks freeze.
// addPicks=false (automatic runs) never adds a pick for a new game; it can still re-price, take off, and bring back
// picks Coach already published.
export function mergeCard(state: State, card: any, season: number, week: number, addPicks = true, nowMs = Date.now()): CardChanges {
  const wk = String(week), at = nowIso();
  const ch: CardChanges = { added: [], back: [], off: [], moved: [], locked: [], leans: [], upgraded: [], bumped: [] };
  const A = new Map<string, any>(card.assessments.map((a: any) => [a.gameId, a]));
  const mine = () => state.picks.filter(p => p.app === "claude" && p.season === season && p.week === week);
  const floating = (p: any) => (p.status === "open" || p.status === "off") && !p.lockedAt;
  const qualifies = (p: any) => (A.get(p.gameId)?.eligible ?? []).includes(`${p.market}:${p.side}`);
  const onNow = () => mine().filter(onCard);

  // 1. Lock: anything at or past kickoff - 60 min freezes as it stands. No re-price, add or drop after this.
  for (const p of mine()) {
    if (!floating(p) || nowMs < lockTime(p)) continue;
    ensureAudit(p); p.lockedAt = at; log(p, "locked", at);
    ch.locked.push(p.status === "open" ? `${lbl(p)} locked` : `${p.away}@${p.home}: off the card at lock, no pick`);
  }

  // 2. Float every unlocked pick with the market. Plays that stop qualifying go off; leans that start qualifying become plays.
  for (const p of mine()) {
    if (!floating(p)) continue;
    const a = A.get(p.gameId), c = a?.sides?.find((s: any) => s.market === p.market && s.side === p.side);
    if (!a || !c) continue; // no line right now: leave it as it is
    ensureAudit(p);
    const before = tag(p), moved = reprice(p, a, c, at);
    if (p.status !== "open") continue;
    if (tierOf(p) === "play" && !qualifies(p)) {
      p.status = "off"; p.offAt = at; log(p, "off", at);
      ch.off.push(`${tag(p)} off the card, EV ${(c.ev * 100).toFixed(1)}%${c.ev >= barFor(p.market) ? " (no cited reason)" : ""}`);
    } else if (tierOf(p) === "lean" && qualifies(p)) {
      p.tier = "play"; log(p, "upgraded", at); ch.upgraded.push(`${tag(p)} is now a play`);
    } else if (moved) {
      log(p, "repriced", at); ch.moved.push(`${before} -> ${tag(p)}`);
    }
  }

  // A game that already has a Coach pick this week (on, off or pulled) only ever gets that same pick back:
  // the pick follows the line, it never flips to the other side or market.
  const picked = new Set(mine().map(p => p.gameId));
  const ids = new Set(state.picks.map(q => q.id));
  const post = (p: any, tier: "play" | "lean") => {
    let pid = `claude:${p.gameId}:${p.market}`, n = 2;
    while (ids.has(pid)) pid = `claude:${p.gameId}:${p.market}:${n++}`;
    p.id = pid; ids.add(pid); p.tier = tier; p.publishedAt = at; ensureAudit(p);
    state.picks.push(p); picked.add(p.gameId);
  };
  const turnOn = (p: any, tier: "play" | "lean") => { p.status = "open"; p.tier = tier; p.backAt = at; log(p, "on", at); };

  // 3. Plays, best EV first, up to MAX_PLAYS on the card: off plays that qualify again, then (research runs) new games.
  const plays: { ev: number; back?: any; fresh?: any }[] = mine().filter(p => p.status === "off" && floating(p) && qualifies(p)).map(p => ({ ev: p.ev, back: p }));
  if (addPicks) for (const p of card.candidates ?? card.picks ?? []) if (!picked.has(p.gameId) && nowMs < lockTime(p)) plays.push({ ev: p.ev, fresh: p });
  plays.sort((x, y) => y.ev - x.ev);
  const used = new Set<string>();
  for (const c of plays) {
    const gid = (c.back ?? c.fresh).gameId;
    if (used.has(gid)) continue;
    if (onNow().length >= MAX_PLAYS) {
      // A play beats a lean: bump the weakest unlocked lean to make room.
      const lean = onNow().filter(p => tierOf(p) === "lean" && !p.lockedAt).sort((x, y) => x.ev - y.ev)[0];
      if (!lean) break;
      lean.status = "off"; lean.offAt = at; log(lean, "off", at); ch.bumped.push(`${lbl(lean)} bumped for a play`);
    }
    if (c.back) { turnOn(c.back, "play"); ch.back.push(`${tag(c.back)} back on the card`); }
    else { post(c.fresh, "play"); ch.added.push(tag(c.fresh)); }
    used.add(gid);
  }

  // 4. Leans fill the card up to MIN_CARD. Every run, the open slots go to the best available sides by EV: leans already
  //    on the card, off picks on unlocked games, and (research runs) Coach's best side on each new researched game.
  //    A lean already on the card keeps its slot unless a challenger beats it by LEAN_KEEP, so the card doesn't churn.
  const fixed = onNow().filter(p => tierOf(p) === "play" || p.lockedAt).length;
  const slots = Math.max(0, MIN_CARD - fixed);
  const pool: { score: number; p: any; kind: "keep" | "back" | "fresh" }[] = [];
  for (const p of mine()) {
    if (!floating(p) || (p.status === "open" && tierOf(p) === "play")) continue;
    if (p.status === "open") pool.push({ score: p.ev + LEAN_KEEP, p, kind: "keep" });
    else pool.push({ score: p.ev, p, kind: "back" });
  }
  if (addPicks) for (const p of card.leanCandidates ?? []) if (!picked.has(p.gameId) && nowMs < lockTime(p)) pool.push({ score: p.ev, p, kind: "fresh" });
  pool.sort((x, y) => y.score - x.score);
  const chosen = new Set<any>(), games = new Set<string>();
  for (const c of pool) { if (chosen.size >= slots) break; if (games.has(c.p.gameId)) continue; chosen.add(c); games.add(c.p.gameId); }
  for (const c of pool) {
    const take = chosen.has(c);
    if (c.kind === "keep" && !take) { c.p.status = "off"; c.p.offAt = at; log(c.p, "off", at); ch.off.push(`${lbl(c.p)} off the card${slots ? ", a better side took its place" : ", not needed"}`); }
    if (c.kind === "back" && take) { turnOn(c.p, "lean"); ch.leans.push(`${lbl(c.p)} on the card`); }
    if (c.kind === "fresh" && take) { post(c.p, "lean"); ch.leans.push(`Lean ${tag(c.p)} posted`); }
  }

  // 6. Board statuses.
  const old: Record<string, any> = {};
  for (const a of state.weeks[wk]?.assessments ?? []) old[a.gameId] = a;
  for (const a of card.assessments) {
    const s = slim(a), gp = mine().filter(p => p.gameId === a.gameId);
    const on = gp.find(onCard), off = gp.filter(p => p.status === "off").pop();
    if (on) {
      s.status = tierOf(on) === "lean" ? "lean" : "play";
      s.play = { selection: on.selection, price: on.price, ev: on.ev, pWin: on.pWin, pPush: on.pPush, market: on.market, side: on.side, number: on.number,
        tier: tierOf(on), locked: !!on.lockedAt, lockAt: on.lockAt, firstNumber: on.firstNumber, firstPrice: on.firstPrice };
      if (s.status === "lean") s.passReason = `Lean: Coach's best side here at ${(on.ev * 100).toFixed(1)}% EV. It fills the card to ${MIN_CARD} picks and is tracked apart from plays. ${a.passReason ?? ""}`.trim();
    } else if (off && !gp.some(p => p.status === "withdrawn")) {
      s.status = "pass"; delete s.play;
      s.passReason = off.lockedAt
        ? `Off the card at lock: ${tag(off)} was ${(off.ev * 100).toFixed(1)}% EV. No pick on this game.`
        : `Off the card for now: ${tag(off)} is ${(off.ev * 100).toFixed(1)}% EV at the current line. It can come back on before the lock an hour before kickoff.`;
    } else if (a.qualified) {
      s.status = "pass"; delete s.play;
      s.passReason = nowMs >= lockTime(a) ? "Locked an hour before kickoff with no pick on the card."
        : onNow().length >= MAX_PLAYS ? `Qualified, but the card already has ${MAX_PLAYS} picks.`
        : "At current lines this clears the bar. Coach re-checks the news before playing it on the next check-in.";
    }
    old[a.gameId] = s;
  }
  const prevNote = state.weeks[wk]?.coachNote;
  state.weeks[wk] = { season, week, updatedAt: at, assessments: Object.values(old).sort((x: any, y: any) => (x.kickoff ?? "").localeCompare(y.kickoff ?? "") || x.gameId.localeCompare(y.gameId)) };
  if (prevNote) state.weeks[wk].coachNote = prevNote;
  state.ratings = card.ratings;
  return ch;
}

// Pre-lock pulls for real news. Permanent for the week; a locked pick can no longer be pulled.
export function applyWithdrawals(state: State, research: Research, nowMs = Date.now()) {
  const out: string[] = [], at = nowIso();
  for (const [gid, r] of Object.entries(research ?? {})) {
    const reason = r && typeof r === "object" ? r.withdraw : null;
    if (!reason) continue;
    for (const p of state.picks) {
      if (p.app === "claude" && p.gameId === gid && (p.status === "open" || p.status === "off") && !isLocked(p, nowMs)) {
        const was = p.status;
        ensureAudit(p);
        Object.assign(p, { status: "withdrawn", withdrawnAt: at, withdrawReason: String(reason) });
        if (was === "off") p.offWhenPulled = true; // wasn't on the card: no "if played" grade, not a pulled pick
        log(p, "withdrawn", at);
        if (was === "open") out.push(p.selection);
      }
    }
  }
  return out;
}

export function snapshotSharpai(state: State, s: any | null, err?: string) {
  const changes: string[] = [];
  if (!s) { state.sharpaiError = `SharpAI card unreachable at ${nowIso()}: ${err ?? ""}`; return changes; }
  delete state.sharpaiError;
  const live = new Map<string, any>();
  for (const p of s.picks ?? []) {
    if (p.season !== 2026 || (p.week ?? 0) < START_WEEK || (p.cohort ?? "active") !== "active") continue;
    if (p.market !== "spread" && p.market !== "total") continue;
    live.set(`sharpai:${p.id}`, p);
  }
  const known = new Map(state.picks.filter(p => p.app === "sharpai").map(p => [p.id, p]));
  for (const [pid, p] of live) {
    const k = known.get(pid);
    if (k) { if (k.status === "withdrawn") { k.status = "open"; changes.push(`SharpAI restored ${k.selection}`); } continue; }
    let side = String(p.side).toLowerCase();
    if (p.market === "spread" && side !== "home" && side !== "away") side = String(p.side).toUpperCase() === p.home ? "home" : "away";
    state.picks.push({ id: pid, app: "sharpai", season: p.season, week: p.week,
      gameId: `${p.season}-w${String(p.week).padStart(2, "0")}-${p.away.toLowerCase()}-${p.home.toLowerCase()}`,
      kickoff: p.kickoff, away: p.away, home: p.home, market: p.market, side, selection: p.selection, number: p.number, price: p.price,
      units: p.units ?? 1, ev: p.ev, pWin: p.pWin, case: p.footballCase || p.reason || "", caseAgainst: p.caseAgainst ?? "",
      publishedAt: p.publishedAt, firstSeenAt: nowIso(), status: "open" });
    changes.push(`SharpAI added ${p.selection} (${p.price > 0 ? "+" : ""}${p.price}, ${p.units ?? 1}u)`);
  }
  for (const [pid, p] of known) {
    if (!live.has(pid) && p.status === "open" && (!p.kickoff || Date.parse(p.kickoff) > Date.now())) { p.status = "withdrawn"; changes.push(`SharpAI pulled ${p.selection}`); }
  }
  state.sharpaiCheckedAt = nowIso();
  return changes;
}

const ALIAS: Record<string, string> = { LAR: "LA", LA: "LAR", WSH: "WAS", WAS: "WSH" };
export function needsGrading(state: State) {
  const weeks = new Set<string>();
  for (const p of state.picks) {
    if (p.status === "open" || (!("clv" in p) && ["won", "lost", "push"].includes(p.status)) || (p.status === "withdrawn" && p.app === "claude" && !p.offWhenPulled && !("ifPlayed" in p)))
      weeks.add(`${p.season}:${p.week}`);
  }
  return [...weeks].map(s => s.split(":").map(Number) as [number, number]);
}
export function gradeWeek(state: State, season: number, week: number, games: Game[]) {
  const idx = new Map(games.map(g => [`${g.away}@${g.home}`, g]));
  let n = 0;
  for (const p of state.picks) {
    if (p.season !== season || p.week !== week) continue;
    const want = p.status === "open" || (!("clv" in p) && ["won", "lost", "push"].includes(p.status)) || (p.status === "withdrawn" && p.app === "claude" && !p.offWhenPulled && !("ifPlayed" in p));
    if (!want) continue;
    const g = idx.get(`${p.away}@${p.home}`) ?? idx.get(`${ALIAS[p.away] ?? p.away}@${ALIAS[p.home] ?? p.home}`);
    if (!g || g.status !== "complete") continue;
    if (p.status === "withdrawn") p.ifPlayed = gradePick(p, g); else Object.assign(p, gradePick(p, g));
    p.gradedAt = nowIso(); n++;
  }
  return n;
}
