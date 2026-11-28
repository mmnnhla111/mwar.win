# Local-only V1.1 audit suite

Runs **only on this PC** (127.0.0.1). It never deploys, never touches the remote D1 and does not use the normal
local `.wrangler` state: the api-worker runs with its D1 in `.local-audit/wrangler-state` (git-ignored) and throw-away
test secrets passed with `--var`.

```powershell
node tests/local-audit/run-local-audit.mjs --fresh --players=100 --play-seconds=180
```

| File | What it checks |
|:--|:--|
| `01-economy-spec.mjs` | Pure checks of `packages/shared` against `docs/master_system_specification_updated_v1_1.md` (rounding 0.007 C, 55/15/5/5/20, 90/10, −5…−10 % haircut, 26 countries + GLOBAL, ticket conservation, ranks, cheer limits, anti-cheat thresholds). No server needed. |
| `02-simulate-players.mjs` | ~100 players from 21 countries: Telegram sign-up with referral codes (5-level tree), EC charged by country-valued Monetag postbacks + live banner pings, daily missions, real play on the Colyseus game server (Paid-EC + Fast & Mini, restake, leave alive / Rejoin, suicide chests), direct-link cheers, midnight MLM settlement run 3× in parallel. Then every money invariant is checked in D1 (zero-deficit total, wallet = ledger, upline levels, mission gate, tickets settled once). |
| `03-country-economics.mjs` | Value of one ad / one EC ticket / one kill per country, using the Worker's own functions. |
| `04-abuse-probes.mjs` | Can a script create paid value without a real ad or real aim? (banner ping, direct-link timer claim, hit from across the map). |

Options: `--fresh` (new empty local D1), `--skip-sim` (only 01 + 03), `--probes-only` (01, 03, 04).
Output: console, `.local-audit/*.json`, `.local-audit/wrangler.log`, `.local-audit/game-server.log`.
The findings report is `docs/LOCAL_AUDIT_REPORT_V1_1_TH.md`.
