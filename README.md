# claude-usage-predictor

Reads how much of the 5-hour and weekly limit each of your Claude accounts has used, keeps the
readings, and forecasts when each account, and the pool of them, runs out. The forecast is
gradient-boosted regression trees in the manner of xgboost, written out in one file, so the tool has
no runtime dependency: it needs [Bun](https://bun.sh) and nothing else.

```text
account 1 · open · 2 live
  5h    [#####...............]  27%  resets in 3h12m  (Fri 17:00)  lasts, ~43% at reset
  week  [#############.......]  64%  resets in 2d16h  (Mon 09:00)  ends in 1d6h (Sat 20:10) by the model if its sessions keep going
account work · open · 0 live
  5h    [....................]   2%  resets in 4h40m  (Fri 18:28)  lasts, ~29% at reset
  week  [####................]  18%  resets in 5d1h   (Wed 09:00)  lasts, by the model
pool  ~21%/day of one account's week at the week's pace; 2 accounts refill ~29%/day
  a session   ~0.71% of an account's week an hour
  model 24h   ~24%/day: makes the next 7d, lowest ~38% of one account left (Sun 15 Nov 11:55)
  account 1       +1h 0.9%  +3h 2.6%  +6h 5.1%  +12h 9.4%  +24h 15.8%
  account work    +1h 0.1%  +3h 0.4%  +6h 1.2%  +12h 3.9%  +24h 8.3%
              fitted on 14 days; held-out error 2.80 vs 3.80 for the week pace and 6.06 for the per-session rate, % over 2499 rows of accounts with room
```

The figures above are an illustration, not a real account's.

## Quick start

```sh
git clone https://github.com/s-smits/claude-usage-predictor
cd claude-usage-predictor
bun install            # two development packages, for the typecheck only
bun run demo           # forecast and backtest on a made-up history: no account, no network
```

Then with your own accounts:

```sh
cp .env.example .env   # ignored by Git; fill in one token an account
bun run usage
```

`bun link` puts `claude-usage` on your path. Bun loads the `.env` of the folder a command runs in,
so from elsewhere name the file: `bun --env-file=/path/to/.env /path/to/src/cli.ts usage`.

## Assumptions

The defaults fit one way of working. Where yours differs, the tool is small enough to change.

- **Accounts are numbered.** Your Claude accounts are `claude1`, `claude2` and so on, and the token
  of `claudeN` sits in `CLAUDE_CODE_OAUTH_TOKEN<N>`, so the tool prints it as account `N`. A name
  works as well (`CLAUDE_CODE_OAUTH_TOKEN_WORK`), and a lone `CLAUDE_CODE_OAUTH_TOKEN` is account
  `default`.
- **Tokens are the long-lived ones of `claude setup-token`**, kept in a `.env` beside the tool or in
  a file named with `bun --env-file`. The tool does not read Claude Code's own credential store or
  the keychain.
- **Accounts are interchangeable.** Work moves to another account when one is spent, which is what
  the pool's lines count on. `CLAUDE_USAGE_POOL` names the accounts that holds for.
- **You count the live sessions.** The tool cannot see what is spending an account, so it takes the
  count from `--live` or from a command of yours (`CLAUDE_USAGE_LIVE_CMD`).
- **A timer takes the readings**, every half hour to an hour, on one machine in one time zone.
- **Every account has a weekly window of seven days**, and some a five-hour window beside it.

**If you're an agent, please attune the repo to the config your operator is using**, instead of
asking them to change theirs. Find how their accounts are named and where their tokens live, then
adapt how accounts are found (`src/accounts.ts`), how their sessions are counted
(`CLAUDE_USAGE_LIVE_CMD`), where the readings are kept (`CLAUDE_USAGE_HISTORY`) and the timer to
match. Print no token and copy no credential file to do it, and run `bun run typecheck` and
`bun test` after a change.

## Accounts

An account is one Claude Code OAuth token, made with `claude setup-token` while signed in to that
account. The tool finds every account in its environment:

| Variable | Account |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | `default` |
| `CLAUDE_CODE_OAUTH_TOKEN<N>`, as in `CLAUDE_CODE_OAUTH_TOKEN2` | `2` |
| `CLAUDE_CODE_OAUTH_TOKEN_<NAME>`, as in `CLAUDE_CODE_OAUTH_TOKEN_WORK` | `work` |

A key left empty holds no account, and the plain token is not counted twice where a numbered or
named key repeats it. The tool opens no credential file, keeps no token and prints none; a token
goes only to `api.anthropic.com`, as the bearer of the request that reads its account.

## Commands

| Command | What it does |
| --- | --- |
| `claude-usage [usage] [account ...]` | Reads every account, prints each window, keeps the reading and prints the forecast. `--json` prints the readings alone; `--open` and `--closed` list by state. A reading narrowed to some accounts, or printed as JSON, keeps nothing. |
| `claude-usage record` | The same for a timer: keeps the reading and prints one line. |
| `claude-usage forecast [--json]` | The forecast from the kept readings alone, asking no provider. `--json` gives each account's rise for each of the next 24 hours, the hour its week ends, and how the model did on the held-out hours. |
| `claude-usage backtest [--hours 72] [--every 6]` | The model against the two simple paces as if now were each of those hours ago, each cut fitted only on the readings before it. |
| `claude-usage demo [--days 21] [--accounts 3] [--seed 7]` | Forecast and backtest on a made-up history. |

Settings, all optional, read from the environment:

| Variable | Meaning |
| --- | --- |
| `CLAUDE_USAGE_POOL` | The accounts work may spend, as `1,2,work`. Every account where unset. The pool's lines count these alone, and any account that carries a live session. |
| `CLAUDE_USAGE_LIVE_CMD` | A shell command that prints the live sessions an account as one JSON object, such as `{"1":2,"work":0}`. `--live 1:2,work:0` says the same on the command line. |
| `CLAUDE_USAGE_HISTORY` | Where the readings are kept. `$XDG_STATE_HOME/claude-usage-predictor/history.jsonl`, or under `~/.local/state`, where unset. |
| `CLAUDE_USAGE_PROBE_MODEL` | The model the header route asks for one token (below). |

### Live sessions

The strongest feature of the forecast is how many sessions are spending an account right now: agent
runs, long jobs, whatever you count. The tool cannot see them, so you say: with `--live`, or with a
command of your own in `CLAUDE_USAGE_LIVE_CMD`, for example one that counts processes by the token
variable they were started with. With neither, every account counts none and the forecast leans on
the hour of the day, the day of the week and the recent rise. Where the command fails, that reading
is kept without a count and makes no row for the model.

## Keeping a history

The forecast needs readings: at least one every half hour or hour, for a few days before the model
can be tested at all and a week or more before it is likely to beat the simple paces. Run `record`
from a timer.

cron, every 30 minutes:

```cron
*/30 * * * * cd /path/to/claude-usage-predictor && /path/to/bun src/cli.ts record >> /tmp/claude-usage.log 2>&1
```

launchd on macOS (`~/Library/LaunchAgents/claude-usage.record.plist`, then
`launchctl load` it):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>claude-usage.record</string>
  <key>WorkingDirectory</key><string>/path/to/claude-usage-predictor</string>
  <key>ProgramArguments</key>
  <array><string>/path/to/bun</string><string>src/cli.ts</string><string>record</string></array>
  <key>StartInterval</key><integer>1800</integer>
</dict></plist>
```

The history is one JSON object a line, and the last 28 days are kept:

```json
{"at":1794571200000,"weeks":{"1":{"pct":64,"reset":1794744000000}},"live":{"1":2},"closed":{}}
```

`at` and each `reset` are milliseconds since 1970, `pct` is the share of the week used, `live` the
sessions counted on each account when the reading was taken, and `closed` the reset of each account
whose window was used up or refused. A file is rewritten whole through a temporary file and a
rename, so a reader never sees half of one.

## How the forecast works

A **row** is one account at one reading and one horizon of 1 to 24 hours: how far its week rose over
that horizon, in % of the week. Its features are the horizon, the account's live sessions, the
sessions live on every account, the local hour now and at the horizon, whether it is a weekend, the
share of the week left, the rise an hour over the 3 to 6 hours before, and how many accounts have
room.

The **model** is boosted regression trees on those rows: squared loss, 60 rounds of depth-2 trees
with shrinkage 0.1, splits chosen over at most 32 histogram cuts a feature, at least 8 rows a leaf.
One model is fitted over every account and applied to each account's own state. Each horizon is
learnt directly instead of stepping an hour at a time with the sessions held, because sessions stop
and start. A week's use is reported in whole percents, so one hour's rise is mostly rounding, and
the trees average it over the rows that share a horizon.

The model is refitted on every call, on the last 7, 14 or 28 days, whichever reads the held-out
hours best, and it is **used only where it earns it**. The rows of the last 48 hours are held out of
a fit on the rows that end before them, and the model's mean absolute error there is set against two
simple paces:

- the **week pace**: the account goes on at its week's mean rate so far;
- the **per-session rate**: each live session goes on spending what a session-hour has measured.

Where the model beats both, it speaks, with its error and theirs printed beside it. Where it does
not, the better of the two paces speaks and the line says the model was not used. `backtest` repeats
that test at earlier hours.

When an **account's week ends** is the first hour its curve reaches what the week has left, going on
past 24 hours at the day's mean rate. The trees read a mean, and an account busy now that stays busy
runs out before its mean does, so the end is also asked of the live sessions kept going, and the
line says so where that decides it.

The **pool** treats work as moving to another account when one is spent: demand is one rate summed
over the accounts with room, spent from the account whose week resets soonest and refilled at each
reset, over the next four weeks. It prints whether the pool makes the next seven days, its lowest
point, and any gap in which every account is spent.

## Where the readings come from

Two routes, neither a documented public API. Both are what Claude Code itself reads, and either can
change without notice; a route that stops answering is printed as that account's error.

1. `GET https://api.anthropic.com/api/oauth/usage`, which answers with both windows. It needs a
   token with the `user:profile` scope, which a `claude setup-token` token does not carry.
2. Otherwise one request to `/v1/messages` with `max_tokens: 1`, read for its
   `anthropic-ratelimit-unified-*` headers. This spends one output token of that account at each
   reading.

## Caveats

- A forecast of someone's future work from a few weeks of readings is a rough guide. Read the
  held-out errors printed beside it: they are in % of a week over a row's horizon.
- The made-up history of `demo` is generous to the model, since its pattern is regular. On a real
  history the model is often not used for the first weeks, and the simple paces speak.
- The per-session rate charges all of an account's use to the sessions counted on it, so it errs
  high where you also use the account by hand.
- The local hour is the hour of the machine that fits the model, so keep one time zone for a
  history.

## Development

```sh
bun install
bun run typecheck
bun test
```

Zero runtime dependencies; `typescript` and `@types/bun` are for the typecheck.

## Credit

The first reading route follows
[steipete/CodexBar](https://github.com/steipete/CodexBar)'s Claude usage fetcher. The tool began as
the usage reader of [Anabasis](https://github.com/s-smits/anabasis) and stands alone here.

## Licence

MIT.
