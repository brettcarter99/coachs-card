import type { Config } from "@netlify/functions";
import { lockCheck } from "../lib/ops.mts";

// Every 5 minutes: when a Coach pick is close to its lock (an hour before kickoff), re-price it at the current line,
// then freeze it once the lock time passes. Exits after one state read when nothing is near its lock.
export default async () => {
  const origin = Netlify.env.get("URL") ?? "https://coachs-card.netlify.app";
  const r = await lockCheck(origin);
  if (r) console.log("lock", JSON.stringify(r));
};

export const config: Config = { schedule: "*/5 * * * *" };
