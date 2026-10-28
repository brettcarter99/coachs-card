import type { Config } from "@netlify/functions"

// Live NFL lines for Coach's Card: Action Network consensus book 15, spreads and totals only.
// GET /api/lines?week=7[&season=2025]  -> { week, season?, fetchedAt, games: [{ away, home, start, status, spreadHome, spreadHomePrice,
//                              spreadAwayPrice, total, overPrice, underPrice, awayPts, homePts }] }

const BOOK = "15"

export default async (req: Request) => {
  const url = new URL(req.url)
  const week = Number(url.searchParams.get("week"))
  const seasonQ = url.searchParams.get("season"), season = seasonQ === null ? null : Number(seasonQ)
  if (season !== null && (!Number.isInteger(season) || season < 2015 || season > 2030)) {
    return Response.json({ error: "Season must be a year, for example /api/lines?week=7&season=2025." }, { status: 400 })
  }
  if (!Number.isInteger(week) || week < 1 || week > 22) {
    return Response.json({ error: "Pass a week number, for example /api/lines?week=7." }, { status: 400 })
  }
  let data: any
  try {
    const r = await fetch(`https://api.actionnetwork.com/web/v2/scoreboard/publicbetting/nfl?week=${week}${season ? `&season=${season}` : ""}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (CoachsCard)" },
      signal: AbortSignal.timeout(9000),
    })
    if (!r.ok) throw new Error(`status ${r.status}`)
    data = await r.json()
  } catch (e) {
    return Response.json({ error: "Live lines are unavailable right now. The card still shows the published prices." },
      { status: 502, headers: { "Cache-Control": "no-store" } })
  }
  const games = (data.games ?? []).map((g: any) => {
    const abbr: Record<number, string> = {}
    for (const t of g.teams ?? []) abbr[t.id] = t.abbr
    const m = g.markets?.[BOOK]?.event ?? {}
    const row: Record<string, unknown> = {
      away: abbr[g.away_team_id], home: abbr[g.home_team_id], start: g.start_time, status: g.status,
    }
    for (const o of m.spread ?? []) {
      if (o.side === "home") { row.spreadHome = o.value; row.spreadHomePrice = o.odds }
      else row.spreadAwayPrice = o.odds
    }
    for (const o of m.total ?? []) {
      row.total = o.value
      row[o.side === "over" ? "overPrice" : "underPrice"] = o.odds
    }
    const b = g.boxscore
    if (b && typeof b.total_home_points === "number") { row.homePts = b.total_home_points; row.awayPts = b.total_away_points }
    return row
  })
  return Response.json({ week, ...(season ? { season } : {}), fetchedAt: new Date().toISOString(), games }, {
    headers: {
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, s-maxage=90, stale-while-revalidate=120",
    },
  })
}

export const config: Config = { path: "/api/lines", method: "GET" }
