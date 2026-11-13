import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsIn, poolOf } from "../src/accounts.ts";
import { historyFile, keptReadings, snapshotOf, writeReadings } from "../src/history.ts";
import { countsOf, liveCounts, parseLive } from "../src/live.ts";
import type { Snapshot } from "../src/model.ts";
import { weeksFor } from "../src/report.ts";

const folder = mkdtempSync(join(tmpdir(), "claude-usage-test-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("the accounts an environment holds", () => {
  test("numbered, named and plain tokens are each an account, numbers first", () => {
    const held = accountsIn({
      CLAUDE_CODE_OAUTH_TOKEN_WORK: "w",
      CLAUDE_CODE_OAUTH_TOKEN10: "ten",
      CLAUDE_CODE_OAUTH_TOKEN2: "two",
      CLAUDE_CODE_OAUTH_TOKEN: "plain",
      CLAUDE_CODE_OAUTH_TOKEN_home: "h",
      OTHER: "x",
    });
    expect([...held.keys()]).toEqual(["default", "2", "10", "home", "work"]);
    expect(held.get("work")).toBe("w");
  });

  test("a key left empty holds no account, and the plain token is not counted twice", () => {
    const held = accountsIn({
      CLAUDE_CODE_OAUTH_TOKEN: "same",
      CLAUDE_CODE_OAUTH_TOKEN1: "same",
      CLAUDE_CODE_OAUTH_TOKEN2: "  ",
      CLAUDE_CODE_OAUTH_TOKEN3: "",
    });
    expect([...held.keys()]).toEqual(["1"]);
  });

  test("no token, no account", () => {
    expect(accountsIn({ PATH: "/bin" }).size).toBe(0);
  });

  test("the pool is the accounts named, or every one held", () => {
    expect(poolOf({ CLAUDE_USAGE_POOL: " 1, Work ,," }, ["1", "2", "work"])).toEqual(["1", "work"]);
    expect(poolOf({ CLAUDE_USAGE_POOL: "" }, ["1", "2"])).toEqual(["1", "2"]);
    expect(poolOf({}, ["1", "2"])).toEqual(["1", "2"]);
  });
});

describe("the live sessions an account", () => {
  test("a flag names them, accounts left out counting none", () => {
    expect(parseLive("1:2, Work:1")).toEqual({ "1": 2, work: 1 });
    expect(liveCounts({ CLAUDE_USAGE_LIVE_CMD: "exit 1" }, "1:0")).toEqual({ "1": 0 });
    expect(() => parseLive("1")).toThrow();
    expect(() => parseLive("1:two")).toThrow();
    expect(() => parseLive("1:-1")).toThrow();
  });

  test("with neither flag nor command every account counts none", () => {
    expect(liveCounts({}, undefined)).toEqual({});
  });

  test("a command's JSON object is read, and anything else leaves the count unknown", () => {
    expect(liveCounts({ CLAUDE_USAGE_LIVE_CMD: `echo '{"1":2,"Work":0}'` }, undefined)).toEqual({ "1": 2, work: 0 });
    expect(liveCounts({ CLAUDE_USAGE_LIVE_CMD: "echo nothing" }, undefined)).toBeNull();
    expect(liveCounts({ CLAUDE_USAGE_LIVE_CMD: "exit 3" }, undefined)).toBeNull();
    expect(countsOf("[1,2]")).toBeNull();
    expect(countsOf('{"1":"two"}')).toBeNull();
  });
});

describe("the readings kept", () => {
  const one: Snapshot = { at: 1000, weeks: { "1": { pct: 42, reset: 9000 } }, live: { "1": 2 }, closed: {} };
  const two: Snapshot = { at: 2000, weeks: { "1": { pct: 43, reset: 9000 } }, live: { "1": 0 }, closed: { "1": 9000 } };

  test("come back as they were written, and leave no staging file", () => {
    const file = join(folder, "nested", "history.jsonl");
    writeReadings(file, [one, two]);
    expect(keptReadings(file)).toEqual([one, two]);
    expect(readdirSync(join(folder, "nested"))).toEqual(["history.jsonl"]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  test("a missing file holds none, and a line that is no reading is skipped", () => {
    expect(keptReadings(join(folder, "absent.jsonl"))).toEqual([]);
    const file = join(folder, "torn.jsonl");
    writeFileSync(file, `${JSON.stringify(one)}\n{"at":3000,"weeks":\n\n[1,2]\n${JSON.stringify(two)}\n`);
    expect(keptReadings(file)).toEqual([one, two]);
  });

  test("live sessions named `runs` are read as `live`, and a reading without either keeps none", () => {
    expect(snapshotOf('{"at":1,"weeks":{"1":{"pct":4,"reset":9}},"runs":{"1":3}}')).toEqual({
      at: 1,
      weeks: { "1": { pct: 4, reset: 9 } },
      live: { "1": 3 },
    });
    expect(snapshotOf('{"at":1,"weeks":{"1":{"pct":4,"reset":9}}}')).toEqual({
      at: 1,
      weeks: { "1": { pct: 4, reset: 9 } },
    });
  });

  test("the file is where the environment says, then under the state folder", () => {
    expect(historyFile({ CLAUDE_USAGE_HISTORY: "/somewhere/h.jsonl" })).toBe("/somewhere/h.jsonl");
    expect(historyFile({ XDG_STATE_HOME: "/state" })).toBe("/state/claude-usage-predictor/history.jsonl");
    expect(historyFile({}).endsWith(join(".local", "state", "claude-usage-predictor", "history.jsonl"))).toBe(true);
  });

  test("a reading of a few accounts takes the others from the last reading still in its window", () => {
    const kept: Snapshot[] = [
      { at: 1000, weeks: { "1": { pct: 10, reset: 5000 }, "2": { pct: 20, reset: 1500 } }, live: {} },
    ];
    const read = weeksFor([{ account: "3", pct: 30, reset: 7000 }], kept, 2000);
    // Account 2's window ended before now, so its old share is not carried.
    expect(read).toEqual({ "1": { pct: 10, reset: 5000 }, "3": { pct: 30, reset: 7000 } });
  });
});
