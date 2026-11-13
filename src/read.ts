/**
 * One reading of an account: how much of its 5-hour and weekly window is used, and when each resets.
 *
 * Two routes, the first taken from steipete/CodexBar@afeb28146cec
 * (Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift): GET
 * /api/oauth/usage with its headers, window keys, `limits` entries and `extra_usage`. That endpoint
 * needs the `user:profile` scope, and a `claude setup-token` token carries only `user:inference`
 * (403 oauth_scope_insufficient), so for those the reading comes from the
 * `anthropic-ratelimit-unified-*` headers of a one-token request to the smallest model instead: the
 * numbers the CLI shows, for one output token.
 *
 * Neither route is a documented public API. Both are what Claude Code itself reads, and either can
 * change without notice; a route that stops answering is reported as that account's error.
 */
import { spawnSync } from "node:child_process";

export interface Window {
  readonly pct: number | null;
  readonly resetsAt: string | null;
  readonly status?: string;
}

export interface Read {
  readonly via: "oauth-usage" | "ratelimit-headers";
  /** Null where the account reports no five-hour limit at all. */
  readonly fiveHour: Window | null;
  readonly sevenDay: Window;
  readonly notes: readonly string[];
}

export interface Failed {
  readonly error: string;
}

/** One account's reading, or why there is none. */
export type Reading = { readonly account: string } & (Read | Failed);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "https://api.anthropic.com";
const BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 30_000;
/** The model the header route sends its one-token request to; `CLAUDE_USAGE_PROBE_MODEL` overrides it. */
export const PROBE_MODEL = "claude-haiku-4-5-20251001";
const NOTED = [
  ["seven_day_opus", "opus"],
  ["seven_day_sonnet", "sonnet"],
  ["seven_day_oauth_apps", "oauth apps"],
  ["seven_day_routines", "routines"],
] as const;

const asRecord = (value: Json | undefined): { [key: string]: Json } | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
const isString = (value: Json | undefined): value is string => typeof value === "string";
const isNumber = (value: Json | undefined): value is number => typeof value === "number";

/** The usage endpoint's window `value`: its share used and its reset. */
function windowOf(value: Json | undefined): Window {
  const window = asRecord(value);
  const used = window?.utilization;
  const reset = window?.resets_at;
  return { pct: isNumber(used) ? used : null, resetsAt: isString(reset) ? reset : null };
}

async function viaOAuthUsage(token: string, agent: string, fetcher: Fetch): Promise<Read | Failed> {
  const res = await fetcher(`${BASE}/api/oauth/usage`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
      "anthropic-beta": BETA,
      "user-agent": agent,
    },
  });
  if (res.status === 401) return { error: "OAuth request unauthorized: the token needs a new login" };
  if (res.status === 429) {
    return {
      error: `the usage endpoint is rate limited (Retry-After ${res.headers.get("retry-after") ?? "?"})`,
    };
  }
  if (!res.ok) {
    const code = /"error_code":"([^"]+)"/.exec(await res.text())?.[1];
    return { error: `OAuth error: HTTP ${String(res.status)}${code === undefined ? "" : ` – ${code}`}` };
  }
  const body = asRecord(JSON.parse(await res.text()) as Json) ?? {};
  const notes = NOTED.flatMap(([key, label]) => {
    const { pct } = windowOf(body[key]);
    return pct === null ? [] : [`${label} week ${String(Math.round(pct))}%`];
  });
  for (const entry of Array.isArray(body.limits) ? body.limits : []) {
    const limit = asRecord(entry);
    const model = asRecord(asRecord(limit?.scope)?.model)?.display_name;
    const percent = limit?.percent;
    if (isString(model) && isNumber(percent)) {
      const group = [limit?.group, limit?.kind].find(isString) ?? "";
      notes.push(`${model} ${group} ${String(Math.round(percent))}%`.replaceAll(/\s+/g, " "));
    }
  }
  const extra = asRecord(body.extra_usage);
  if (extra?.is_enabled === true) {
    const currency = isString(extra.currency) ? extra.currency : "";
    const used = isNumber(extra.used_credits) ? extra.used_credits : 0;
    const limit = isNumber(extra.monthly_limit) ? String(extra.monthly_limit) : "?";
    notes.push(`extra usage ${String(used)}/${limit} ${currency}`.trim());
  }
  return {
    via: "oauth-usage",
    fiveHour: windowOf(body.five_hour),
    sevenDay: windowOf(body.seven_day),
    notes,
  };
}

async function viaRateLimitHeaders(
  token: string,
  agent: string,
  model: string,
  fetcher: Fetch,
): Promise<Read | Failed> {
  const res = await fetcher(`${BASE}/v1/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA,
      "content-type": "application/json",
      "user-agent": agent,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "." }],
    }),
  });
  const header = (key: string) => res.headers.get(`anthropic-ratelimit-unified-${key}`);
  if (header("5h-utilization") === null && header("7d-utilization") === null) {
    const revoked = res.status === 401 ? " (token revoked or expired)" : "";
    return { error: `messages HTTP ${String(res.status)}, no rate-limit headers${revoked}` };
  }
  const win = (key: string): Window => {
    const used = header(`${key}-utilization`);
    const reset = header(`${key}-reset`);
    const window: Window = {
      pct: used === null ? null : Number(used) * 100,
      resetsAt:
        reset === null ? null : /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toISOString() : reset,
    };
    const status = header(`${key}-status`);
    return status === null ? window : { ...window, status };
  };
  const overage = header("overage-status");
  const why = header("overage-disabled-reason");
  const claim = header("representative-claim");
  const notes = [
    ...(overage === null ? [] : [`overage ${overage}${why === null ? "" : ` (${why})`}`]),
    ...(claim === null ? [] : [`binding ${claim}`]),
  ];
  return { via: "ratelimit-headers", fiveHour: win("5h"), sevenDay: win("7d"), notes };
}

/** `read` without its five-hour window where the account reports nothing of one: no share, no
 *  reset and no status, beside a week that was read. Some plans carry no five-hour limit, and the
 *  provider then names none, which would otherwise print as a bar that could not be read. */
function planned(read: Read): Read {
  const five = read.fiveHour;
  const silent = five?.pct === null && five.resetsAt === null && five.status === undefined;
  return silent && read.sevenDay.pct !== null ? { ...read, fiveHour: null } : read;
}

/** The user agent the routes send: the installed CLI's version, or a fallback where none answers. */
function agentOf(): string {
  // A missing `claude` is a status of null here, not a throw.
  const ran = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const version = ran.status === 0 ? ran.stdout.trim().split(/\s+/)[0] : undefined;
  return `claude-code/${version === undefined || version === "" ? "2.1.0" : version}`;
}

/** Each of `wanted` read with its token of `tokens`, by the first route that answers. */
export async function readAccounts(
  wanted: readonly string[],
  tokens: ReadonlyMap<string, string>,
  options: { readonly fetch?: Fetch; readonly agent?: string; readonly model?: string } = {},
): Promise<Reading[]> {
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const agent = options.agent ?? agentOf();
  const model = options.model ?? PROBE_MODEL;
  return Promise.all(
    wanted.map(async (account): Promise<Reading> => {
      const token = tokens.get(account);
      if (token === undefined) return { account, error: `no token for account ${account} in the environment` };
      try {
        const first = await viaOAuthUsage(token, agent, fetcher);
        if (!("error" in first)) return { account, ...planned(first) };
        const second = await viaRateLimitHeaders(token, agent, model, fetcher);
        if (!("error" in second)) return { account, ...planned(second) };
        return { account, error: `${first.error}; ${second.error}` };
      } catch (error) {
        return { account, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
