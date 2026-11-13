import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReadings } from "../src/history.ts";
import { synthetic } from "../src/synthetic.ts";

const folder = mkdtempSync(join(tmpdir(), "claude-usage-cli-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const cli = join(import.meta.dir, "..", "src", "cli.ts");

/** A Node that runs TypeScript as it stands (22.18 or later), where this machine has one. */
function nodeHere(): string | null {
  const node = Bun.which("node");
  if (node === null) return null;
  const [major = 0, minor = 0] = Bun.spawnSync([node, "--version"]).stdout.toString().trim().slice(1).split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 18) ? node : null;
}
const node = nodeHere();
const runtimes = [{ name: "Bun", program: process.execPath }, ...(node === null ? [] : [{ name: "Node", program: node }])];

test("Node is among the runtimes tested wherever the environment says it must be", () => {
  if (process.env.REQUIRE_NODE === "1") expect(node).not.toBeNull();
});

for (const { name, program } of runtimes) {
  /** The command line as a person runs it under this runtime, in `cwd` (an empty folder unless
   *  named, so that no `.env` of theirs is loaded), with `env` as its whole environment. */
  const run = (args: readonly string[], env: Record<string, string> = {}, cwd = folder) => {
    const done = Bun.spawnSync([program, cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: folder, NODE_NO_WARNINGS: "1", ...env },
    });
    return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
  };
  const kept = join(folder, `kept-${name}.jsonl`);

  describe(`the command line under ${name}`, () => {
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

    test("reads the `.env` of the folder it runs in, and leaves a variable already set as it is", () => {
      const home = join(folder, `dotenv-${name}`);
      mkdirSync(home);
      const [inFile, inEnv] = [join(home, "file.jsonl"), join(home, "env.jsonl")];
      const one = synthetic({ now: Date.now(), days: 1, accounts: ["1"], seed: 1, every: 60 });
      writeReadings(inFile, one.slice(-1));
      writeReadings(inEnv, one.slice(-2));
      writeFileSync(join(home, ".env"), `CLAUDE_USAGE_HISTORY=${inFile}\n`);
      expect(run(["forecast"], {}, home).out).toContain(", 1 kept");
      expect(run(["forecast"], { CLAUDE_USAGE_HISTORY: inEnv }, home).out).toContain(", 2 kept");
    });

    test("forecasts every account of a kept history as JSON, from the file alone", () => {
      const history = synthetic({ now: Date.now(), days: 12, accounts: ["1", "work"], seed: 5, every: 60 });
      writeReadings(kept, history);
      const { code, out, err } = run(["forecast", "--json"], { CLAUDE_USAGE_HISTORY: kept, TZ: "UTC" });
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
      const { out } = run(["forecast", "--json"], { CLAUDE_USAGE_HISTORY: kept, CLAUDE_USAGE_POOL: "work", TZ: "UTC" });
      const read = JSON.parse(out) as { accounts: { account: string; inPool: boolean; live: number }[] };
      for (const { account, inPool, live } of read.accounts) expect(inPool).toBe(account === "work" || live > 0);
    }, 120_000);

    test("counts live sessions with a command of the person's own", () => {
      // No account is held, so the command line stops before it asks a provider; the count is read
      // in `live.ts` by the same call, which the store's tests cover under Bun.
      const { code } = run(["record"], { CLAUDE_USAGE_LIVE_CMD: `echo '{"1":2}'` });
      expect(code).toBe(1);
    });
  });
}

describe("the same history under each runtime", () => {
  test.skipIf(node === null)("gives the same model and the same curves", () => {
    const file = join(folder, "same.jsonl");
    const at = Date.UTC(2026, 10, 13, 12);
    writeReadings(file, synthetic({ now: at, days: 12, accounts: ["1", "2"], seed: 9, every: 60 }));
    // `backtest` reads no clock: each cut is counted back from the last reading.
    const [bun, other] = [process.execPath, node ?? ""].map((program) =>
      Bun.spawnSync([program, cli, "backtest", "--hours", "24", "--every", "24"], {
        cwd: folder,
        env: { PATH: process.env.PATH ?? "", HOME: folder, NODE_NO_WARNINGS: "1", CLAUDE_USAGE_HISTORY: file, TZ: "UTC" },
      }).stdout.toString(),
    );
    expect(bun).toContain("as if now were");
    expect(other).toBe(bun ?? "");
  }, 120_000);
});
