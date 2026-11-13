import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReadings } from "../src/history.ts";
import { synthetic } from "../src/synthetic.ts";

const folder = mkdtempSync(join(tmpdir(), "claude-usage-cli-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const cli = join(import.meta.dir, "..", "src", "cli.ts");

/** The command line as a person runs it, in an empty folder so that no `.env` of theirs is loaded,
 *  with `env` as its whole environment. */
function run(args: readonly string[], env: Record<string, string> = {}) {
  const done = Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: folder,
    env: { PATH: process.env.PATH ?? "", HOME: folder, ...env },
  });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

describe("the command line", () => {
  test("says how to name an account where the environment holds none, and asks no provider", () => {
    const { code, out, err } = run(["usage"], { CLAUDE_USAGE_HISTORY: join(folder, "none.jsonl") });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("no account here: set CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("prints its verbs", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    for (const verb of ["record", "forecast", "backtest", "demo"]) expect(out).toContain(`claude-usage ${verb}`);
  });

  test("forecasts from an empty history without failing", () => {
    const env = { CLAUDE_USAGE_HISTORY: join(folder, "empty.jsonl") };
    expect(run(["forecast"], env)).toMatchObject({ code: 0, out: expect.stringContaining("no reading kept yet") });
    expect(run(["forecast", "--json"], env)).toMatchObject({ code: 0, out: "null\n" });
    expect(run(["backtest"], env).code).toBe(0);
  });

  test("forecasts every account of a kept history as JSON, from the file alone", () => {
    const file = join(folder, "kept.jsonl");
    const history = synthetic({ now: Date.now(), days: 12, accounts: ["1", "work"], seed: 5, every: 60 });
    writeReadings(file, history);
    const { code, out, err } = run(["forecast", "--json"], { CLAUDE_USAGE_HISTORY: file, TZ: "UTC" });
    expect(err).toBe("");
    expect(code).toBe(0);
    const read = JSON.parse(out) as {
      horizonHours: number;
      heldOut: { rows: number } | null;
      accounts: { account: string; pct: number; riseByHour: number[] | null; inPool: boolean }[];
    };
    expect(read.horizonHours).toBe(24);
    expect(read.heldOut?.rows ?? 0).toBeGreaterThan(0);
    expect(read.accounts.map(({ account }) => account).toSorted()).toEqual(["1", "work"]);
    for (const account of read.accounts) {
      expect(account.inPool).toBe(true);
      // The curve is there where the model beat both simple paces, and absent where it did not.
      if (account.riseByHour !== null) expect(account.riseByHour).toHaveLength(24);
    }
  }, 120_000);

  test("leaves an account outside the pool out of it", () => {
    const { out } = run(["forecast", "--json"], {
      CLAUDE_USAGE_HISTORY: join(folder, "kept.jsonl"),
      CLAUDE_USAGE_POOL: "work",
      TZ: "UTC",
    });
    const read = JSON.parse(out) as { accounts: { account: string; inPool: boolean; live: number }[] };
    for (const { account, inPool, live } of read.accounts) expect(inPool).toBe(account === "work" || live > 0);
  }, 120_000);
});
