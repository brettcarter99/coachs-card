import type { Config } from "@netlify/functions";
import { refresh } from "../lib/ops.mts";

// Every two hours: refresh the board at current lines, snapshot SharpAI, grade finished games,
// and roll to the next week once the current week is final. Never publishes a pick on its own.
export default async () => {
  const origin = Netlify.env.get("URL") ?? "https://coachs-card.netlify.app";
  const r = await refresh(origin);
  console.log("refresh", JSON.stringify({ week: r.week, graded: r.graded, rolled: r.rolled, sharpai: r.sharpai }));
};

export const config: Config = { schedule: "23 */2 * * *" };
