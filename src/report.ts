/**
 * What `usage` prints of one account, and the views of the history its verbs share: each window as a
 * bar with its reset and when it runs out, by the model where it speaks and by the pace so far
 * where it does not.
 */
import {
  assess,
  type Assessment,
  byTime,
  clock,
  type End,
  endWords,
  HOUR_MS,
  type Snapshot,
  spanOf,
  stamp,
  type Week,
} from "./model.ts";
import type { Window } from "./read.ts";
import { resetOf } from "./state.ts";

/** What `window` of `length` minutes holds at its reset at the pace it was used so far, or null
 *  where either is unread. */
function atReset(window: Window, length: number, now: number): number | null {
  const reset = resetOf(window.resetsAt);
  if (reset === null || window.pct === null) return null;
  const used = length - (reset - now) / 60_000;
  return used <= 0 ? window.pct : (window.pct * length) / used;
}

/** When `window` of `length` minutes runs out at the pace it was used so far: it opened `length`
 *  minutes before its reset, so 40% in the first 2 of 7 days runs out 3 days on. */
export function pace(window: Window, length: number, now: number): string {
  const reset = resetOf(window.resetsAt);
  if (reset === null || window.pct === null) return "";
  if (window.pct >= 100) return "spent";
  const left = (reset - now) / 60_000;
  const used = length - left;
  if (window.pct <= 0 || used <= 0) return "lasts";
  const mins = Math.round(((100 - window.pct) * used) / window.pct);
  return mins >= left
    ? `lasts, ~${String(Math.round(atReset(window, length, now) ?? window.pct))}% at reset`
    : `ends in ${spanOf(mins)} (${clock(now + mins * 60_000)})`;
}

/** One window as a line: a bar, its share, its reset, and its end by `end` or by its pace. */
export function shown(window: Window, length: number, now: number, end?: End): string {
  const filled = window.pct === null ? null : Math.min(20, Math.round(window.pct / 5));
  const bar = filled === null ? "?".repeat(20) : "#".repeat(filled) + ".".repeat(20 - filled);
  const pct = window.pct === null ? "  ?" : `${String(Math.round(window.pct)).padStart(3)}%`;
  const reset = resetOf(window.resetsAt);
  const until =
    reset === null
      ? ""
      : `resets in ${spanOf(Math.max(0, Math.round((reset - now) / 60_000))).padEnd(6)} (${clock(reset)})`;
  const status = window.status !== undefined && window.status !== "allowed";
  const said = end === undefined || (window.pct ?? 0) >= 100 ? pace(window, length, now) : endWords(end, now);
  const tail = status ? `  ${said.padEnd(26)}  [${window.status}]` : `  ${said}`;
  return `[${bar}] ${pct}  ${until}${tail.trimEnd()}`;
}

/** The weeks the model reads now: those `weeks` read, and the other accounts' from the last of
 *  `kept` where still in their window, so a reading of a few accounts reads every account. */
export function weeksFor(weeks: readonly Week[], kept: readonly Snapshot[], now: number): Snapshot["weeks"] {
  const others = Object.entries(byTime(kept).at(-1)?.weeks ?? {});
  return {
    ...Object.fromEntries(others.filter(([, { reset }]) => reset > now)),
    ...Object.fromEntries(weeks.map(({ account, pct, reset }) => [account, { pct, reset }])),
  };
}

/** `history` assessed at each of `cuts` hours before its last reading, as if each were now: the
 *  walk a forecast is trusted on, since every cut holds out hours no fit before it saw. */
export function backtest(
  history: readonly Snapshot[],
  cuts: readonly number[],
): { at: number; assessment: Assessment | null }[] {
  const last = byTime(history).at(-1)?.at;
  if (last === undefined) return [];
  return cuts.map((hours) => {
    const at = last - hours * HOUR_MS;
    return { at, assessment: assess(history.filter((one) => one.at <= at), at) };
  });
}

/** The walk as a table, and how often the model beat both simple paces. */
export function backtestLines(walk: readonly { at: number; assessment: Assessment | null }[]): string[] {
  const read = walk.flatMap(({ at, assessment }) => (assessment === null ? [] : [{ at, assessment }]));
  const rows = walk.map(({ at, assessment }) => {
    if (assessment === null) return `${stamp(at).padEnd(20)}too few readings before it to fit and hold out`;
    const { days, held, error, week, perLive, model } = assessment;
    const best = model !== null ? "model" : week <= perLive ? "week pace" : "per session";
    return `${stamp(at).padEnd(20)}${`${String(days)}d`.padEnd(6)}${String(held).padStart(6)}  ${error.toFixed(2).padStart(6)}  ${week.toFixed(2).padStart(9)}  ${perLive.toFixed(2).padStart(11)}  ${best}`;
  });
  const won = read.filter(({ assessment }) => assessment.model !== null).length;
  return [
    `${"as if now were".padEnd(20)}${"fit".padEnd(6)}${"rows".padStart(6)}  ${"model".padStart(6)}  ${"week pace".padStart(9)}  ${"per session".padStart(11)}  best`,
    ...rows,
    read.length === 0
      ? "no cut had enough readings: keep recording, at least once an hour, for a few days"
      : `the model beat both simple paces at ${String(won)} of ${String(read.length)} cuts (mean absolute error, % of a week over each row's horizon)`,
  ];
}
