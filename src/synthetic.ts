/**
 * A made-up history, for the demo and the tests: no account, no network, nothing recorded from a
 * real machine. Accounts spend their week through live sessions that mostly start on working hours,
 * a quiet background use follows the clock, the provider reports whole percents, and each week
 * resets on its own day. The same seed gives the same readings.
 */
import { HOUR_MS, type Snapshot } from "./model.ts";

const WEEK = 168 * HOUR_MS;

/** A small seeded generator (mulberry32): the same seed, the same numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface Shape {
  /** The last reading's time. */
  readonly now: number;
  readonly days: number;
  readonly accounts: readonly string[];
  readonly seed: number;
  /** Minutes between readings. */
  readonly every: number;
}

/** `shape` as readings, oldest first. */
export function synthetic(shape: Shape): Snapshot[] {
  const random = seeded(shape.seed);
  const start = shape.now - shape.days * 24 * HOUR_MS;
  const state = shape.accounts.map((account, at) => ({
    account,
    used: random() * 40,
    live: 0,
    // Each account's week resets on its own day, a fixed share of a week after the start.
    reset: start + ((at + 1) / (shape.accounts.length + 1)) * WEEK,
  }));
  const snapshots: Snapshot[] = [];
  const step = (shape.every * 60_000) / HOUR_MS;
  for (let at = start; at <= shape.now; at += shape.every * 60_000) {
    const date = new Date(at);
    const hour = date.getHours();
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const working = !weekend && hour >= 9 && hour < 19;
    for (const one of state) {
      if (at >= one.reset) Object.assign(one, { used: 0, reset: one.reset + WEEK });
      // A session starts more readily on working hours and lasts about three hours; a person's own
      // use, which nobody counts as a session, follows the working day.
      if (random() < (working ? 0.25 : 0.02) * step && one.live < 3) one.live += 1;
      if (random() < 0.3 * step && one.live > 0) one.live -= 1;
      const spent = one.used >= 100;
      const own = working ? 0.3 + random() * 0.3 : 0.03;
      const rate = spent ? 0 : one.live * (0.5 + random() * 0.4) + own;
      one.used = Math.min(100, one.used + rate * step);
    }
    snapshots.push({
      at,
      weeks: Object.fromEntries(
        state.map(({ account, used, reset }) => [account, { pct: Math.floor(used), reset }]),
      ),
      live: Object.fromEntries(state.map(({ account, live, used }) => [account, used >= 100 ? 0 : live])),
      closed: Object.fromEntries(state.flatMap(({ account, used, reset }) => (used >= 100 ? [[account, reset]] : []))),
    });
  }
  return snapshots;
}
