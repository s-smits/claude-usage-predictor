/**
 * Whether an account is open or closed, read from one reading. Closed means a window is used up or
 * refused, until that window's reset; two closed windows mean the later reset. An account that
 * could not be read is neither, since a read that failed says nothing of its limits. Each snapshot
 * keeps who it found closed and until when, and a closed account opens by the clock at its reset.
 */
import type { Reading, Window } from "./read.ts";

export const resetOf = (iso: string | null): number | null => {
  const at = iso === null ? Number.NaN : new Date(iso).getTime();
  return Number.isNaN(at) ? null : at;
};

const windowOpen = (window: Window): boolean =>
  (window.status ?? "allowed").startsWith("allowed") && (window.pct ?? 0) < 100;

/** Until when `reading` is closed, `until: null` where its closed window names no reset, or null
 *  for an account that is open or could not be read. */
export function closedOf(reading: Reading): { until: number | null } | null {
  if ("error" in reading) return null;
  const closed = [reading.fiveHour ?? [], reading.sevenDay].flat().filter((window) => !windowOpen(window));
  if (closed.length === 0) return null;
  const resets = closed.map(({ resetsAt }) => resetOf(resetsAt));
  return { until: resets.includes(null) ? null : Math.max(...resets.flatMap((at) => at ?? [])) };
}

/** The accounts of `readings` closed until a known reset, as a snapshot keeps them. */
export function closedResets(readings: readonly Reading[]): Record<string, number> {
  return Object.fromEntries(
    readings.flatMap((reading) => {
      const until = closedOf(reading)?.until ?? null;
      return until === null ? [] : [[reading.account, until]];
    }),
  );
}

/** The `readings` a filter lists: all with neither flag, and one that could not be read under
 *  neither flag's name, since it is neither open nor closed. */
export function listedBy(
  readings: readonly Reading[],
  { open, closed }: { readonly open: boolean; readonly closed: boolean },
): readonly Reading[] {
  if (!open && !closed) return readings;
  return readings.filter((reading) => !("error" in reading) && (closedOf(reading) === null ? open : closed));
}

/** What a head line says of `reading`, in `clockOf`'s words. */
export function stateWords(
  reading: Reading,
  pool: readonly string[],
  clockOf: (at: number) => string,
): string {
  if ("error" in reading) return "";
  const closed = closedOf(reading);
  const state =
    closed === null ? "open" : `closed${closed.until === null ? "" : ` until ${clockOf(closed.until)}`}`;
  return ` · ${state}${pool.includes(reading.account) ? "" : " · not in the pool"}`;
}
