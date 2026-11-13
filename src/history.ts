/**
 * The readings kept: one JSON line a reading, 28 days of them, in one local file that never leaves
 * the machine. It holds no token, only each account's name, share used, reset and live sessions.
 *
 *   {"at":1790000000000,"weeks":{"1":{"pct":42,"reset":1790400000000}},"live":{"1":2},"closed":{}}
 *
 * `CLAUDE_USAGE_HISTORY` names the file; otherwise it is
 * `$XDG_STATE_HOME/claude-usage-predictor/history.jsonl`, with `~/.local/state` for the folder
 * where that is unset. A line that does not parse is skipped, and a reading that names its live
 * sessions `runs` is read as one that names them `live`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "./accounts.ts";
import { HOUR_MS, type Snapshot } from "./model.ts";

/** The readings kept, for the model's longest window. */
export const KEPT_MS = 28 * 24 * HOUR_MS;

export function historyFile(env: Env): string {
  const named = env.CLAUDE_USAGE_HISTORY;
  if (named !== undefined && named.trim() !== "") return named;
  const state = env.XDG_STATE_HOME;
  const folder = state !== undefined && state.trim() !== "" ? state : join(homedir(), ".local", "state");
  return join(folder, "claude-usage-predictor", "history.jsonl");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function counts(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, count]) => (typeof count === "number" ? [[key, count]] : [])),
  );
}

/** One line of the file as a snapshot, or null where it is none. */
export function snapshotOf(line: string): Snapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.at !== "number" || !isRecord(parsed.weeks)) return null;
  const weeks = Object.fromEntries(
    Object.entries(parsed.weeks).flatMap(([account, week]) =>
      isRecord(week) && typeof week.pct === "number" && typeof week.reset === "number"
        ? [[account, { pct: week.pct, reset: week.reset }]]
        : [],
    ),
  );
  const live = counts(parsed.live ?? parsed.runs);
  const closed = counts(parsed.closed);
  return {
    at: parsed.at,
    weeks,
    ...(live === undefined ? {} : { live }),
    ...(closed === undefined ? {} : { closed }),
  };
}

export function keptReadings(file: string): Snapshot[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => (line.trim() === "" ? [] : (snapshotOf(line) ?? [])));
}

/** Writes `snapshots` as the whole file, through a file beside it, so a reader never sees half. */
export function writeReadings(file: string, snapshots: readonly Snapshot[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const staged = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(staged, `${snapshots.map((one) => JSON.stringify(one)).join("\n")}\n`);
  renameSync(staged, file);
}
