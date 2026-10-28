import type { Config, Context } from "@netlify/functions";
import * as S from "../lib/store.mts";
import * as O from "../lib/ops.mts";

// Coach's Card API.
//   GET  /api/state  (also /data/state.json)   the full card, picks and results
//   GET  /api/research?week=7                  Coach's research notes for a week
//   POST /api/research   (Bearer token)        {week, entries: {gameId: entry}, coachNote?} -> rebuild card
//   POST /api/refresh    (Bearer token)        lines, grading, SharpAI snapshot, rollover
//   GET  /api/duel.html                        head-to-head page for the Claude artifact

const json = (d: unknown, status = 200, cache = "no-cache") =>
  Response.json(d, { status, headers: { "Cache-Control": cache, "Access-Control-Allow-Origin": "*" } });

// SHA-256 of Coach's run token. The token itself lives only in Brett's private scheduled-task prompts.
const TOKEN_SHA256 = "3155d11035831f48d1378d704977edcf295cde4940f70d1cdd0ca9ce461c16b1";
async function authorized(req: Request) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1].trim()));
  const hex = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === TOKEN_SHA256;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url), origin = url.origin, path = url.pathname;
  try {
    if (req.method === "GET" && (path === "/api/state" || path === "/data/state.json")) {
      return json(await S.loadState(origin));
    }
    if (path === "/api/research" && req.method === "GET") {
      const state = await S.loadState(origin);
      const week = Number(url.searchParams.get("week") ?? state.currentWeek);
      return json(await S.loadResearch(origin, 2026, week));
    }
    if (path === "/api/research" && req.method === "POST") {
      if (!(await authorized(req))) return json({ error: "Not authorized." }, 401, "no-store");
      return json(await O.researchUpdate(origin, await req.json()), 200, "no-store");
    }
    if (path === "/api/refresh" && req.method === "POST") {
      if (!(await authorized(req))) return json({ error: "Not authorized." }, 401, "no-store");
      return json(await O.refresh(origin), 200, "no-store");
    }
    if (path === "/api/duel.html" && req.method === "GET") {
      const [state, tpl] = await Promise.all([S.loadState(origin), fetch(`${origin}/duel-template.html`).then(r => r.text())]);
      state.backtest = { summary: "A walk-forward test on 361 games (2025 and 2026 weeks 1-7, Action Network closing lines) found Claude's raw ratings sat closer to average than the market, so 130 of 136 ratings-only plays were underdogs. Engine v1.1 removes that lean: the same test now splits 30 underdogs and 36 favorites, and totals 26 overs and 26 unders. Ratings alone still don't beat the close, so since v1.2 a play that clears the bar also needs a cited football reason, and when fewer than 3 clear it Claude plays its best remaining sides to reach 3 a week. That is expected because a closing line already holds nearly everything public. An edge has to come from a better number than the close and from news the line hasn't absorbed yet, which is why CLV is the first thing to watch." };
      const html = tpl.replace("/*__STATE__*/", JSON.stringify(state).replace(/<\//g, "<\\/"));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return json({ error: "Not found." }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500, "no-store");
  }
};

export const config: Config = {
  path: ["/api/state", "/data/state.json", "/api/research", "/api/refresh", "/api/duel.html"],
};
