/**
 * How many sessions are live on each account when a reading is taken. A session is whatever spends
 * an account for hours on end: an agent, a long job, a terminal left working. The count is the
 * model's strongest feature and the per-session pace's only one, and the tool cannot see it by
 * itself, so it is told:
 *
 *   --live 1:2,work:1               on the command line, accounts left out counting none
 *   CLAUDE_USAGE_LIVE_CMD=<command>  a shell command that prints one JSON object, {"1":2,"work":1}
 *
 * With neither, every account counts none: the forecast then learns from the clock and each
 * account's own recent rise alone. A command that fails leaves the reading without a count, and
 * such a reading makes no row, since a guess of none would teach the model that busy hours are idle.
 */
import { spawnSync } from "node:child_process";
import type { Env } from "./accounts.ts";

/** `spec`, such as `1:2,work:1`, as a count an account. */
export function parseLive(spec: string): Record<string, number> {
  return Object.fromEntries(
    spec
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => {
        const [account = "", count = ""] = entry.split(":").map((part) => part.trim());
        const live = Number(count);
        if (account === "" || count === "" || !Number.isInteger(live) || live < 0) {
          throw new Error(`--live takes <account>:<count>, such as 1:2,work:1, not "${entry}"`);
        }
        return [account.toLowerCase(), live];
      }),
  );
}

/** What `text` holds as counts, or null where it is no JSON object of non-negative numbers. */
export function countsOf(text: string): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (!entries.every(([, count]) => typeof count === "number" && count >= 0)) return null;
  return Object.fromEntries(entries.map(([account, count]) => [account.toLowerCase(), Number(count)]));
}

/** The live sessions an account: `flag` where given, else what `CLAUDE_USAGE_LIVE_CMD` prints, else
 *  none anywhere. Null where the command failed or printed something else. */
export function liveCounts(env: Env, flag: string | undefined): Record<string, number> | null {
  if (flag !== undefined) return parseLive(flag);
  const command = env.CLAUDE_USAGE_LIVE_CMD;
  if (command === undefined || command.trim() === "") return {};
  const ran = spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 20_000,
  });
  const counted = ran.status === 0 ? countsOf(ran.stdout) : null;
  if (counted === null) {
    console.error("CLAUDE_USAGE_LIVE_CMD gave no JSON object of counts: this reading keeps no live sessions");
  }
  return counted;
}
