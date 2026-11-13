import { describe, expect, test } from "bun:test";
import { readAccounts } from "../src/read.ts";
import { closedOf, closedResets, listedBy, stateWords } from "../src/state.ts";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A provider that answers each path with `answers`, and keeps what it was asked. */
function provider(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    return (answers[path] ?? (() => new Response("", { status: 404 })))();
  };
  return { calls, fetch };
}

const usageBody = {
  five_hour: { utilization: 12, resets_at: "2026-11-13T15:00:00Z" },
  seven_day: { utilization: 64.5, resets_at: "2026-11-17T09:00:00Z" },
  seven_day_opus: { utilization: 30, resets_at: null },
  extra_usage: { is_enabled: true, used_credits: 5, monthly_limit: 50, currency: "USD" },
};
const scopeRefusal = () => new Response('{"error_code":"oauth_scope_insufficient"}', { status: 403 });
const headers = (pairs: Record<string, string>) =>
  new Response("{}", {
    status: 200,
    headers: Object.fromEntries(
      Object.entries(pairs).map(([key, value]) => [`anthropic-ratelimit-unified-${key}`, value]),
    ),
  });
const options = { agent: "claude-code/test", model: "probe-model" };

describe("the usage endpoint", () => {
  test("gives both windows, the notes, and asks nothing else", async () => {
    const { calls, fetch } = provider({ "/api/oauth/usage": () => Response.json(usageBody) });
    const [reading] = await readAccounts(["1"], new Map([["1", "secret-one"]]), { ...options, fetch });
    expect(reading).toEqual({
      account: "1",
      via: "oauth-usage",
      fiveHour: { pct: 12, resetsAt: "2026-11-13T15:00:00Z" },
      sevenDay: { pct: 64.5, resetsAt: "2026-11-17T09:00:00Z" },
      notes: ["opus week 30%", "extra usage 5/50 USD"],
    });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret-one");
  });

  test("an account that names no five-hour limit at all is read without one", async () => {
    const body = { seven_day: usageBody.seven_day };
    const { fetch } = provider({ "/api/oauth/usage": () => Response.json(body) });
    const [reading] = await readAccounts(["1"], new Map([["1", "t"]]), { ...options, fetch });
    expect(reading).toMatchObject({ fiveHour: null, sevenDay: { pct: 64.5 } });
  });
});

describe("the header route", () => {
  test("is taken where the token's scope refuses the usage endpoint", async () => {
    const { calls, fetch } = provider({
      "/api/oauth/usage": scopeRefusal,
      "/v1/messages": () =>
        headers({
          "5h-utilization": "0.25",
          "5h-reset": "1794582000",
          "5h-status": "allowed",
          "7d-utilization": "1",
          "7d-reset": "1794900000",
          "7d-status": "rejected",
          "representative-claim": "seven_day",
        }),
    });
    const [reading] = await readAccounts(["2"], new Map([["2", "secret-two"]]), { ...options, fetch });
    expect(reading).toEqual({
      account: "2",
      via: "ratelimit-headers",
      fiveHour: { pct: 25, resetsAt: new Date(1_794_582_000_000).toISOString(), status: "allowed" },
      sevenDay: { pct: 100, resetsAt: new Date(1_794_900_000_000).toISOString(), status: "rejected" },
      notes: ["binding seven_day"],
    });
    const sent = JSON.parse(String(calls[1]?.init?.body)) as { model: string; max_tokens: number };
    expect(sent).toMatchObject({ model: "probe-model", max_tokens: 1 });
  });

  test("an answer without the headers is that account's error, naming both routes", async () => {
    const { fetch } = provider({
      "/api/oauth/usage": scopeRefusal,
      "/v1/messages": () => new Response("{}", { status: 401 }),
    });
    const [reading] = await readAccounts(["2"], new Map([["2", "t"]]), { ...options, fetch });
    expect(reading).toEqual({
      account: "2",
      error:
        "OAuth error: HTTP 403 – oauth_scope_insufficient; messages HTTP 401, no rate-limit headers (token revoked or expired)",
    });
  });
});

describe("accounts that cannot be read", () => {
  test("one with no token is an error and asks no provider", async () => {
    const { calls, fetch } = provider({});
    const [reading] = await readAccounts(["9"], new Map(), { ...options, fetch });
    expect(reading).toHaveProperty("error");
    expect(calls).toHaveLength(0);
  });

  test("a network failure is that account's error and leaves the others read", async () => {
    const fetch = async (url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get("authorization") === "Bearer bad") throw new Error("socket closed");
      return Response.json(usageBody);
    };
    const readings = await readAccounts(["1", "2"], new Map([["1", "bad"], ["2", "good"]]), { ...options, fetch });
    expect(readings[0]).toEqual({ account: "1", error: "socket closed" });
    expect(readings[1]).toMatchObject({ account: "2", via: "oauth-usage" });
  });
});

describe("open and closed", () => {
  const open = {
    account: "1",
    via: "oauth-usage" as const,
    fiveHour: { pct: 10, resetsAt: "2026-11-13T15:00:00Z" },
    sevenDay: { pct: 50, resetsAt: "2026-11-17T09:00:00Z" },
    notes: [],
  };
  const spent = { ...open, account: "2", sevenDay: { pct: 100, resetsAt: "2026-11-17T09:00:00Z" } };
  const refused = { ...open, account: "3", fiveHour: { pct: 80, resetsAt: "2026-11-13T15:00:00Z", status: "rejected" } };
  const both = { ...spent, account: "4", fiveHour: refused.fiveHour };
  const unread = { account: "5", error: "no answer" };

  test("a used-up or refused window closes an account until that window's reset", () => {
    expect(closedOf(open)).toBeNull();
    expect(closedOf(spent)).toEqual({ until: Date.parse("2026-11-17T09:00:00Z") });
    expect(closedOf(refused)).toEqual({ until: Date.parse("2026-11-13T15:00:00Z") });
    // Two closed windows mean the later reset.
    expect(closedOf(both)).toEqual({ until: Date.parse("2026-11-17T09:00:00Z") });
    expect(closedOf(unread)).toBeNull();
  });

  test("a snapshot keeps the closed accounts alone, and a filter lists by state", () => {
    const readings = [open, spent, refused, unread];
    expect(Object.keys(closedResets(readings))).toEqual(["2", "3"]);
    expect(listedBy(readings, { open: true, closed: false }).map(({ account }) => account)).toEqual(["1"]);
    expect(listedBy(readings, { open: false, closed: true }).map(({ account }) => account)).toEqual(["2", "3"]);
    expect(listedBy(readings, { open: false, closed: false })).toHaveLength(4);
  });

  test("a head line says an account outside the pool is so", () => {
    const clockOf = () => "then";
    expect(stateWords(open, ["1"], clockOf)).toBe(" · open");
    expect(stateWords(spent, ["1"], clockOf)).toBe(" · closed until then · not in the pool");
    expect(stateWords(unread, ["1"], clockOf)).toBe("");
  });
});
