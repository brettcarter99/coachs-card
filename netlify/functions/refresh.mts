import type { Config } from "@netlify/functions";
import { refresh } from "../lib/ops.mts";

// Every two hours: refresh the board at current lines (open Coach picks float with the line until an hour before
// kickoff), snapshot SharpAI, grade finished games, and roll to the next week once the current week is final.
// Never adds a pick for a new game on its own.
export default async () => {
  const origin = Netlify.env.get("URL") ?? "https://coachs-card.netlify.app";
  const r = await refresh(origin);
  console.log("refresh", JSON.stringify({ week: r.week, graded: r.graded, rolled: r.rolled, sharpai: r.sharpai,
    moved: r.moved, off: r.off, back: r.back, locked: r.locked }));
};

export const config: Config = { schedule: "23 */2 * * *" };
