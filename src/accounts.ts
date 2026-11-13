/**
 * Which Claude accounts this process holds, read from its environment alone. An account is one
 * Claude Code OAuth token (`claude setup-token`):
 *
 *   CLAUDE_CODE_OAUTH_TOKEN          the plain account, named `default`
 *   CLAUDE_CODE_OAUTH_TOKEN<N>       account `<N>`, as in CLAUDE_CODE_OAUTH_TOKEN2
 *   CLAUDE_CODE_OAUTH_TOKEN_<NAME>   account `<name>`, as in CLAUDE_CODE_OAUTH_TOKEN_WORK
 *
 * The tool opens no file of credentials and prints no token: Bun loads `.env`, or the file named
 * with `bun --env-file=<file>`, into the environment before the tool starts.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export const TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
/** The plain token's account. */
const PLAIN = "default";
/** A numbered or named account's key, with its suffix captured. */
const KEYED = new RegExp(`^${TOKEN}(\\d+|_[A-Za-z0-9]+)$`);

const hasText = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/** Numbers first in their order, then names in theirs. */
function byName(one: string, other: string): number {
  const [a, b] = [Number(one), Number(other)];
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
  if (Number.isNaN(a) !== Number.isNaN(b)) return Number.isNaN(a) ? 1 : -1;
  return one.localeCompare(other);
}

/** Every account `env` holds, by name, with its token. A key left empty holds none, as in a copied
 *  `.env.example`; the plain token is an account of its own only where no keyed one repeats it. */
export function accountsIn(env: Env): Map<string, string> {
  const keyed = Object.entries(env)
    .flatMap(([key, value]): [string, string][] => {
      const suffix = KEYED.exec(key)?.[1];
      return suffix === undefined || !hasText(value)
        ? []
        : [[suffix.replace(/^_/, "").toLowerCase(), value.trim()]];
    })
    .toSorted(([one], [other]) => byName(one, other));
  const plain = env[TOKEN];
  const own = hasText(plain) && !keyed.some(([, token]) => token === plain.trim());
  return new Map([...(own ? ([[PLAIN, plain.trim()]] as [string, string][]) : []), ...keyed]);
}

/** The accounts work may spend: those `CLAUDE_USAGE_POOL` names, such as `1,2,work`, or every one
 *  of `held`. An account out of the pool is still read and forecast, but counts as neither demand
 *  nor room when the pool is asked how long it lasts. */
export function poolOf(env: Env, held: readonly string[]): string[] {
  const named = env.CLAUDE_USAGE_POOL?.split(",")
    .map((account) => account.trim().toLowerCase())
    .filter((account) => account !== "");
  return named === undefined || named.length === 0 ? [...held] : named;
}
