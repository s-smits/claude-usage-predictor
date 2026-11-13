#!/usr/bin/env bun
/**
 * How much of each Claude account's 5-hour and weekly window is used, when each runs out, and,
 * read over every account, when the pool of them runs out.
 *
 *   claude-usage [usage] [account ...] [--json] [--open] [--closed] [--live 1:2,work:1]
 *   claude-usage record [--live 1:2,work:1]
 *   claude-usage forecast [--json]
 *   claude-usage backtest [--hours 72] [--every 6]
 *   claude-usage demo [--days 21] [--accounts 3] [--seed 7]
 *
 * `usage` reads every account the environment holds (`accounts.ts`), prints each, keeps the reading
 * (`history.ts`) and prints the forecast (`model.ts`). Named accounts, `--json`, `--open` and
 * `--closed` narrow what is printed, and a reading of a few accounts keeps nothing. `record` is
 * `usage` for a timer: it keeps the reading and prints one line. `forecast` and `backtest` read the
 * kept history alone and ask no provider. `demo` runs both on a made-up history.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { accountsIn, poolOf, TOKEN } from "./accounts.ts";
import { historyFile, KEPT_MS, keptReadings, writeReadings } from "./history.ts";
import { liveCounts } from "./live.ts";
import {
  assess,
  byTime,
  clock,
  HORIZON,
  HOUR_MS,
  LEAST_LIVE_HOURS,
  modelLines,
  perLiveRate,
  poolLine,
  type Snapshot,
  spanOf,
  splitsOf,
  stamp,
  type Week,
} from "./model.ts";
import { PROBE_MODEL, readAccounts } from "./read.ts";
import { backtest, backtestLines, shown, weeksFor } from "./report.ts";
import { closedResets, listedBy, resetOf, stateWords } from "./state.ts";
import { synthetic } from "./synthetic.ts";

const FLAG = { type: "boolean", default: false } as const;
/** The per-session rate reads the readings of the last eight days. */
const RATE_MS = 8 * 24 * HOUR_MS;

const rateLine = (rate: number | null) =>
  rate === null
    ? `  a session   no measured rate yet (under ${String(LEAST_LIVE_HOURS)} session-hours on record)`
    : `  a session   ~${rate.toFixed(2)}% of an account's week an hour`;

/** `usage` and `record`. */
async function usage(args: readonly string[], quiet: boolean): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { json: FLAG, open: FLAG, closed: FLAG, live: { type: "string" } },
  });
  const env = process.env;
  const tokens = accountsIn(env);
  if (tokens.size === 0) {
    throw new Error(
      `no account here: set ${TOKEN}, ${TOKEN}<N> or ${TOKEN}_<NAME> in .env, or in a file named with --env-file=<file>`,
    );
  }
  const held = [...tokens.keys()];
  const wanted = positionals.length > 0 ? positionals.map((account) => account.toLowerCase()) : held;
  const live = values.json ? null : liveCounts(env, values.live);
  const probe = env.CLAUDE_USAGE_PROBE_MODEL;
  const readings = await readAccounts(wanted, tokens, {
    model: probe === undefined || probe.trim() === "" ? PROBE_MODEL : probe,
  });
  const now = Date.now();
  const onEach = (account: string) => live?.[account] ?? 0;
  const pool = poolOf(env, held);
  const weeks = readings.flatMap((reading): Week[] => {
    const reset = "error" in reading ? null : resetOf(reading.sevenDay.resetsAt);
    const spendable = pool.includes(reading.account) || onEach(reading.account) > 0;
    return "error" in reading || reading.sevenDay.pct === null || reset === null
      ? []
      : [{ account: reading.account, pct: reading.sevenDay.pct, reset, room: spendable }];
  });
  const history = historyFile(env);
  const kept = keptReadings(history);
  const rate = perLiveRate(kept.filter(({ at }) => now - at < RATE_MS));
  // The pool's lines and the history are the whole view's; a reading of a few accounts keeps nothing.
  const whole = !values.json && positionals.length === 0 && weeks.length > 0;
  const read = weeksFor(weeks, whole ? [] : kept, now);
  const snapshot: Snapshot = {
    at: now,
    weeks: read,
    closed: closedResets(readings),
    ...(live === null
      ? {}
      : { live: Object.fromEntries(Object.keys(read).map((account) => [account, onEach(account)])) }),
  };
  const recorded = [...kept.filter(({ at }) => now - at < KEPT_MS), snapshot];
  if (whole) writeReadings(history, recorded);
  if (quiet) {
    const unread = readings.filter((reading) => "error" in reading).map(({ account }) => account);
    console.log(
      `kept ${String(weeks.length)} of ${String(readings.length)} accounts${unread.length === 0 ? "" : ` (unread: ${unread.join(", ")})`}; ${String(recorded.length)} readings in ${history}`,
    );
    return;
  }
  const listed = listedBy(readings, values);
  if (values.json) {
    console.log(JSON.stringify(listed, null, 2));
    return;
  }
  const forecast = weeks.length === 0 ? null : modelLines(weeks, recorded, assess(recorded, now), now, rate);
  for (const reading of listed) {
    const count = live === null ? "" : ` · ${String(onEach(reading.account))} live`;
    const head = `account ${reading.account}${stateWords(reading, pool, clock)}${count}`;
    console.log(
      "error" in reading
        ? `${head}\n  ${reading.error}`
        : `${head}${reading.fiveHour === null ? "" : `\n  5h    ${shown(reading.fiveHour, 5 * 60, now)}`}\n  week  ${shown(reading.sevenDay, 7 * 1440, now, forecast?.ends?.get(reading.account))}${reading.notes.length > 0 ? `\n  ${reading.notes.join(" · ")}` : ""}`,
    );
  }
  if (!whole) return;
  console.log(poolLine(weeks, held.length - weeks.length, now));
  console.log(rateLine(rate));
  console.log(forecast?.lines.join("\n"));
}

/** The weeks of the last reading of `history` still in their window at `now`. */
function lastWeeks(history: readonly Snapshot[], pool: readonly string[] | null, now: number): Week[] {
  const last = byTime(history).at(-1);
  return Object.entries(last?.weeks ?? {}).flatMap(([account, { pct, reset }]) =>
    reset > now
      ? [{ account, pct, reset, room: pool === null || pool.includes(account) || (last?.live?.[account] ?? 0) > 0 }]
      : [],
  );
}

/** What `forecast` prints of `history`, as lines or as one JSON object. */
function forecastOf(history: readonly Snapshot[], pool: readonly string[] | null, now: number, json: boolean): string {
  const last = byTime(history).at(-1);
  if (last === undefined) return json ? "null" : "no reading kept yet: run `claude-usage` or `claude-usage record` first";
  const weeks = lastWeeks(history, pool, now);
  const rate = perLiveRate(history.filter(({ at }) => now - at < RATE_MS));
  const assessment = assess(history, now);
  const { lines, ends, rises } = modelLines(weeks, history, assessment, now, rate);
  if (json) {
    return JSON.stringify(
      {
        at: now,
        lastReading: last.at,
        horizonHours: HORIZON,
        modelUsed: assessment?.model != null,
        heldOut:
          assessment === null
            ? null
            : {
                rows: assessment.held,
                fittedOnDays: assessment.days,
                model: assessment.error,
                weekPace: assessment.week,
                perSession: assessment.perLive,
              },
        perSessionRate: rate,
        accounts: weeks.map((week) => ({
          account: week.account,
          pct: week.pct,
          reset: week.reset,
          inPool: week.room !== false,
          live: last.live?.[week.account] ?? 0,
          riseByHour: rises?.[week.account] ?? null,
          endsAt: ends?.get(week.account)?.at ?? null,
          endsByLiveSessions: ends?.get(week.account)?.live ?? false,
        })),
      },
      null,
      2,
    );
  }
  const age = Math.round((now - last.at) / 60_000);
  const heads = weeks.map((week) => {
    const end = ends?.get(week.account);
    const ending = end?.at ?? null;
    const said =
      week.pct >= 100
        ? "  spent"
        : end === undefined
          ? ""
          : ending === null
            ? "  lasts, by the model"
            : `  ends ${stamp(ending)} by the model${end.live ? " if its sessions keep going" : ""}`;
    return `account ${week.account.padEnd(8)}${String(Math.round(week.pct)).padStart(3)}%  resets ${stamp(week.reset)}${said}`;
  });
  const splits =
    assessment?.model == null
      ? []
      : [
          `              splits: ${splitsOf(assessment.model)
            .filter(({ splits: count }) => count > 0)
            .map(({ feature, splits: count }) => `${feature} ${String(count)}`)
            .join(", ")}`,
        ];
  return [
    `last reading ${spanOf(age)} ago (${stamp(last.at)}), ${String(history.length)} kept`,
    ...heads,
    poolLine(weeks, 0, now),
    rateLine(rate),
    ...lines,
    ...splits,
  ].join("\n");
}

function forecast(args: readonly string[]): void {
  const { values } = parseArgs({ args: [...args], options: { json: FLAG } });
  const env = process.env;
  const named = env.CLAUDE_USAGE_POOL;
  const pool = named === undefined || named.trim() === "" ? null : poolOf(env, []);
  console.log(forecastOf(keptReadings(historyFile(env)), pool, Date.now(), values.json));
}

const cutsOf = (hours: number, every: number) =>
  Array.from({ length: Math.floor(hours / every) + 1 }, (_, at) => at * every);

function numberOf(value: string, flag: string, least: number): number {
  const read = Number(value);
  if (!Number.isFinite(read) || read < least) throw new Error(`--${flag} takes a number of at least ${String(least)}`);
  return read;
}

function backtestVerb(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: { hours: { type: "string", default: "72" }, every: { type: "string", default: "6" } },
  });
  const cuts = cutsOf(numberOf(values.hours, "hours", 0), numberOf(values.every, "every", 1));
  console.log(backtestLines(backtest(keptReadings(historyFile(process.env)), cuts)).join("\n"));
}

function demo(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      days: { type: "string", default: "21" },
      accounts: { type: "string", default: "3" },
      seed: { type: "string", default: "7" },
    },
  });
  const now = Date.now();
  const many = Math.round(numberOf(values.accounts, "accounts", 1));
  const history = synthetic({
    now,
    days: numberOf(values.days, "days", 1),
    accounts: Array.from({ length: many }, (_, at) => String(at + 1)),
    seed: Math.round(numberOf(values.seed, "seed", 0)),
    every: 60,
  });
  console.log(`a made-up history: ${String(history.length)} readings of ${String(many)} accounts over ${values.days} days\n`);
  console.log(forecastOf(history, null, now, false));
  console.log("");
  console.log(backtestLines(backtest(history, cutsOf(72, 24))).join("\n"));
}

const HELP = `claude-usage: how much of each Claude account's week is used, and when it runs out

  claude-usage [usage] [account ...] [--json] [--open] [--closed] [--live 1:2,work:1]
      read every account, print each, keep the reading and print the forecast
  claude-usage record [--live 1:2,work:1]
      the same for a timer: keep the reading, print one line
  claude-usage forecast [--json]
      the forecast from the kept readings alone, asking no provider
  claude-usage backtest [--hours 72] [--every 6]
      the model against the simple paces, as if now were each of those hours ago
  claude-usage demo [--days 21] [--accounts 3] [--seed 7]
      forecast and backtest on a made-up history, with no account

accounts come from the environment: ${TOKEN}, ${TOKEN}<N>, ${TOKEN}_<NAME>
settings: CLAUDE_USAGE_POOL, CLAUDE_USAGE_LIVE_CMD, CLAUDE_USAGE_HISTORY, CLAUDE_USAGE_PROBE_MODEL`;

/** Bun loads the `.env` of the folder it starts in by itself, and Node only when told. So under Node
 *  the same file is loaded here, unless the command named one (`node --env-file=<file>`). A variable
 *  the environment already holds stays as it is, under either. */
function loadEnv(): void {
  if (process.versions.bun !== undefined) return;
  if (process.execArgv.some((flag) => flag.startsWith("--env-file"))) return;
  if (existsSync(".env")) process.loadEnvFile(".env");
}

async function main(argv: readonly string[]): Promise<void> {
  loadEnv();
  const [verb, ...rest] = argv;
  if (verb === "help" || verb === "--help" || verb === "-h") console.log(HELP);
  else if (verb === "record") await usage(rest, true);
  else if (verb === "forecast") forecast(rest);
  else if (verb === "backtest") backtestVerb(rest);
  else if (verb === "demo") demo(rest);
  else await usage(verb === "usage" ? rest : argv, false);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
