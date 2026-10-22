// Live data for Coach's Card, kept in Netlify Blobs.
import { getStore } from "@netlify/blobs";
import * as C from "./coach.mts";

const store = () => getStore({ name: "coach", consistency: "strong" });

export async function loadState(origin: string): Promise<C.State> {
  const s = await store().get("state", { type: "json" });
  if (s) return s as C.State;
  const seed = await C.getJSON(`${origin}/seed/state.json`); // first run after setup
  await store().setJSON("state", seed);
  return seed;
}
export async function saveState(state: C.State) {
  state.engine = C.ENGINE_VERSION;
  state.updatedAt = C.nowIso();
  await store().setJSON("state", state);
}

const rkey = (season: number, week: number) => `research/${season}-w${String(week).padStart(2, "0")}`;
export async function loadResearch(origin: string, season: number, week: number): Promise<C.Research> {
  const r = await store().get(rkey(season, week), { type: "json" });
  if (r) return r as C.Research;
  try { return await C.getJSON(`${origin}/data/research/research_${season}_w${week}.json`); } catch { return {}; }
}
export async function saveResearch(season: number, week: number, r: C.Research) {
  await store().setJSON(rkey(season, week), r);
}

// One NFL week of Action Network lines/results. Finished weeks never change, so they're cached for good.
export async function weekGames(season: number, week: number, fresh = false): Promise<C.Game[]> {
  const key = `games-v2/${season}-w${String(week).padStart(2, "0")}`;
  if (!fresh) {
    const cached = await store().get(key, { type: "json" });
    if (cached) return cached as C.Game[];
  }
  let espnOk = season < 2026;
  const [an, espn] = await Promise.all([
    C.getJSON(C.anUrl(season, week)),
    season >= 2026 ? C.getJSON(C.espnUrl(season, week)).then(d => { espnOk = true; return d; }).catch(() => null) : Promise.resolve(null),
  ]);
  const games = C.parseGames(an, season, week, C.neutralPairs(espn));
  // Cache only finished weeks with complete data (ESPN supplies the neutral-site flags for this season).
  if (espnOk && games.length && games.every(g => g.status === "complete")) await store().setJSON(key, games);
  return games;
}

export async function history(season: number, week: number): Promise<C.Game[]> {
  const jobs: [number, number][] = [];
  for (let w = 1; w <= 18; w++) jobs.push([season - 1, w]);
  for (let w = 1; w < week; w++) jobs.push([season, w]);
  const out: C.Game[][] = [];
  for (let i = 0; i < jobs.length; i += 4) {
    // A missing week would quietly skew the ratings, so any failure stops the update instead.
    out.push(...await Promise.all(jobs.slice(i, i + 4).map(async ([s, w]) => {
      const g = await weekGames(s, w);
      if (!g.length) throw new Error(`No games returned for ${s} week ${w}.`);
      return g;
    })));
  }
  return out.flat();
}
