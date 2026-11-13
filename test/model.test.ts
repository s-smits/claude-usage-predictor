import { describe, expect, test } from "bun:test";
import {
  ahead,
  assess,
  FEATURES,
  HORIZON,
  HOUR_MS,
  modelLines,
  perLiveRate,
  sameWindow,
  type Snapshot,
  splitsOf,
  weekEnd,
  weekPace,
} from "../src/model.ts";
import { backtest, backtestLines, pace, shown } from "../src/report.ts";
import { synthetic } from "../src/synthetic.ts";

const NOW = Date.UTC(2026, 10, 13, 12);
const WEEK = 168 * HOUR_MS;
const history = synthetic({ now: NOW, days: 14, accounts: ["1", "2", "3"], seed: 7, every: 60 });

describe("a week's window", () => {
  test("two readings share a window where the reset agrees and use has not fallen", () => {
    const reset = NOW + 3 * 24 * HOUR_MS;
    expect(sameWindow({ pct: 10, reset }, { pct: 12, reset: reset + 60_000 })).toBe(true);
    expect(sameWindow({ pct: 10, reset }, { pct: 12, reset: reset + WEEK })).toBe(false);
    // A fall under one reset is a window opened afresh, not a negative rise.
    expect(sameWindow({ pct: 80, reset }, { pct: 0, reset })).toBe(false);
  });

  test("the week pace is floored at twelve hours, so a new window does not extrapolate", () => {
    const opened = NOW - HOUR_MS;
    expect(weekPace({ pct: 6, reset: opened + WEEK }, NOW)).toBe(0.5);
    expect(weekPace({ pct: 48, reset: NOW - 48 * HOUR_MS + WEEK }, NOW)).toBe(1);
  });
});

describe("the hour a week ends", () => {
  const week = { pct: 90, reset: NOW + 3 * 24 * HOUR_MS };
  const flat = (rate: number) => Array.from({ length: HORIZON }, (_, hour) => rate * (hour + 1));

  test("is the first hour the curve reaches what is left", () => {
    expect(weekEnd(flat(2), week, NOW)).toBe(NOW + 5 * HOUR_MS);
  });

  test("goes on past the horizon at the day's mean rate", () => {
    // 0.25% an hour reads 6% in a day, so the 10% left lasts 40 hours.
    expect(weekEnd(flat(0.25), week, NOW)).toBe(NOW + 40 * HOUR_MS);
  });

  test("is null where the reset comes first, and for a spent week", () => {
    expect(weekEnd(flat(0.05), week, NOW)).toBeNull();
    expect(weekEnd(flat(2), { ...week, pct: 100 }, NOW)).toBeNull();
  });

  test("comes sooner where the live sessions kept going would spend faster than the curve", () => {
    expect(weekEnd(flat(0.25), week, NOW, 5)).toBe(NOW + 2 * HOUR_MS);
  });
});

describe("the per-session rate", () => {
  const reset = NOW + 4 * 24 * HOUR_MS;
  const reading = (hour: number, pct: number, live: number): Snapshot => ({
    at: NOW + hour * HOUR_MS,
    weeks: { a: { pct, reset } },
    live: { a: live },
  });

  test("is the rise over the session-hours of the earlier reading", () => {
    const readings = [reading(0, 10, 2), reading(2, 14, 2), reading(4, 18, 2)];
    expect(perLiveRate(readings)).toBe(1);
  });

  test("is null under six session-hours, and ignores an account with no session", () => {
    expect(perLiveRate([reading(0, 10, 1), reading(2, 14, 1)])).toBeNull();
    expect(perLiveRate([reading(0, 10, 0), reading(2, 14, 0), reading(4, 18, 0)])).toBeNull();
  });

  test("reads no span longer than three hours or across a reset", () => {
    expect(perLiveRate([reading(0, 10, 4), reading(5, 30, 4)])).toBeNull();
    const across: Snapshot = { at: NOW + 2 * HOUR_MS, weeks: { a: { pct: 1, reset: reset + WEEK } }, live: { a: 4 } };
    expect(perLiveRate([reading(0, 90, 4), across])).toBeNull();
  });
});

describe("the forecast on a made-up history", () => {
  const assessment = assess(history, NOW);

  test("beats both simple paces on the held-out hours, so the model speaks", () => {
    expect(assessment).not.toBeNull();
    expect(assessment?.model).not.toBeNull();
    expect(assessment?.error ?? 99).toBeLessThan(Math.min(assessment?.week ?? 0, assessment?.perLive ?? 0));
    expect(assessment?.held ?? 0).toBeGreaterThan(1000);
  });

  test("never falls from one hour to the next, and never exceeds what the week has left", () => {
    const model = assessment?.model;
    if (model == null) throw new Error("no model");
    const rises = ahead(model, history);
    const last = history.at(-1);
    expect(Object.keys(rises).toSorted()).toEqual(["1", "2", "3"]);
    for (const [account, curve] of Object.entries(rises)) {
      expect(curve).toHaveLength(HORIZON);
      for (const [hour, rise] of curve.entries()) {
        expect(rise).toBeGreaterThanOrEqual(curve[hour - 1] ?? 0);
        expect(rise).toBeLessThanOrEqual(100 - (last?.weeks[account]?.pct ?? 0));
      }
    }
  });

  test("splits on the features the made-up history was built from", () => {
    const model = assessment?.model;
    if (model == null) throw new Error("no model");
    const splits = splitsOf(model);
    expect(splits).toHaveLength(FEATURES.length);
    const used = new Set(splits.filter(({ splits: count }) => count > 0).map(({ feature }) => feature));
    expect(used.has("live sessions")).toBe(true);
    expect(used.has("local hour")).toBe(true);
  });

  test("names an end for every week it prints, and none where the model is off", () => {
    const weeks = Object.entries(history.at(-1)?.weeks ?? {}).map(([account, week]) => ({ account, ...week }));
    const spoken = modelLines(weeks, history, assessment, NOW, perLiveRate(history));
    expect([...(spoken.ends?.keys() ?? [])].toSorted()).toEqual(["1", "2", "3"]);
    expect(spoken.rises).not.toBeNull();
    const silent = modelLines(weeks, history, null, NOW, null);
    expect(silent.ends).toBeNull();
    expect(silent.lines).toHaveLength(2);
  });

  // Each cut is a fit of its own, a second or so apiece and more on a loaded machine.
  test("holds up at earlier cuts too, each fitted only on the readings before it", () => {
    const walk = backtest(history, [24, 48]);
    expect(walk.map(({ at }) => at)).toEqual([24, 48].map((hours) => NOW - hours * HOUR_MS));
    expect(walk.every(({ assessment: one }) => one !== null)).toBe(true);
    const won = walk.filter(({ assessment: one }) => one?.model != null).length;
    expect(won).toBeGreaterThanOrEqual(1);
    expect(backtestLines(walk)).toHaveLength(4);
  }, 120_000);
});

describe("a made-up history", () => {
  const shape = { now: NOW, days: 9, accounts: ["a", "b"], seed: 3, every: 60 };

  test("is the same for the same seed, and another for another", () => {
    expect(synthetic(shape)).toEqual(synthetic(shape));
    expect(synthetic({ ...shape, seed: 4 })).not.toEqual(synthetic(shape));
  });

  test("ends at now, never passes 100%, and falls only where a week reset", () => {
    const readings = synthetic(shape);
    expect(readings.at(-1)?.at).toBe(NOW);
    expect(readings).toHaveLength(9 * 24 + 1);
    for (const [at, reading] of readings.entries()) {
      for (const [account, week] of Object.entries(reading.weeks)) {
        expect(week.pct).toBeLessThanOrEqual(100);
        expect(week.reset).toBeGreaterThan(reading.at);
        const before = readings[at - 1]?.weeks[account];
        if (before !== undefined && week.pct < before.pct) expect(week.reset).toBe(before.reset + WEEK);
      }
    }
  });
});

describe("a window as a line", () => {
  const window = { pct: 40, resetsAt: new Date(NOW + 5 * 24 * HOUR_MS).toISOString() };

  test("runs out before its reset at the pace so far, or lasts", () => {
    // 40% in the first 2 of 7 days: the other 60% lasts 3 days more, short of the 5 left.
    expect(pace(window, 7 * 1440, NOW)).toStartWith("ends in 3d0h");
    expect(pace({ ...window, pct: 20 }, 7 * 1440, NOW)).toBe("lasts, ~70% at reset");
    expect(pace({ ...window, pct: 100 }, 7 * 1440, NOW)).toBe("spent");
    expect(pace({ pct: null, resetsAt: null }, 7 * 1440, NOW)).toBe("");
  });

  test("is a bar of twenty, its share and its reset, with a refusal named", () => {
    const line = shown({ ...window, status: "rejected" }, 7 * 1440, NOW);
    expect(line).toStartWith("[########............]  40%  resets in 5d0h");
    expect(line).toEndWith("[rejected]");
    expect(shown({ pct: null, resetsAt: null }, 300, NOW)).toStartWith(`[${"?".repeat(20)}]   ?`);
  });

  test("takes the model's end over the pace where one is given", () => {
    expect(shown(window, 7 * 1440, NOW, { at: null, live: false })).toContain("lasts");
    expect(shown(window, 7 * 1440, NOW, { at: NOW + 2 * HOUR_MS, live: true })).toContain("by the model");
  });
});

describe("too little history", () => {
  test("gives no assessment with nothing before the held-out hours", () => {
    expect(assess([], NOW)).toBeNull();
    expect(assess(history.slice(-40), NOW)).toBeNull();
  });

  test("a reading without live sessions makes no row", () => {
    const blind = history.map(({ at, weeks }) => ({ at, weeks }));
    expect(assess(blind, NOW)).toBeNull();
  });

  test("a spent account is left out of the held-out score", () => {
    const reset = NOW + 2 * 24 * HOUR_MS;
    const spent: Snapshot[] = Array.from({ length: 24 * 8 }, (_, hour) => ({
      at: NOW - (24 * 8 - 1 - hour) * HOUR_MS,
      weeks: { a: { pct: 100, reset } },
      live: { a: 1 },
    }));
    // Every row of the held-out hours has nothing left, so there is nothing to score.
    expect(assess(spent, NOW)).toBeNull();
  });
});
