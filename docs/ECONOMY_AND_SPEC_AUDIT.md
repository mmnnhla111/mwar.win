# MWAR.WIN — Economy & Specification Audit

**Date:** 2026-11-23 · **Scope:** `apps/api-worker`, `apps/game-server`, `apps/log-receiver`, `apps/web`, `packages/shared`
**Sources of truth:** `docs/master_system_specification.md` (MSS) and `docs/mlm_daily_unlock_engine.md` (MDU).

The audit was done line by line against the code at commit `5c90db2`. Every rule is listed with where it
lives in code. Items that were **`[ ]` (missing or wrong) at the start of the audit** are marked
*was `[ ]`* together with the fix. After the fixes in this commit, every item below is `[x]`.

A short list of **operator steps** that code cannot do (secrets, migrations, a queue setting) is at the end.
Until those are done, production still runs in `DEV_MOCK_MODE`, where the dev shortcuts stay open on purpose.

---

## 1. Money units and conversion

| # | Rule (spec) | Status | Where |
|---|---|---|---|
| 1.1 | All money is stored as integer **Micro-USD**, 1 USD = 1,000,000 (MSS §2.4) | [x] | `packages/shared/src/constants` (`MICRO_USD_PER_USD`), D1 `INTEGER` columns, PostgreSQL `BIGINT` |
| 1.2 | **1 Coin = 100 Micro-USD** (1 cent = 100 coins) | [x] | `MICRO_USD_PER_COIN = 100n`, `COINS_PER_CENT = 100n`, `microUsdToCoins()` |
| 1.3 | Quest coin rewards are converted with the shared constant, not a literal | [x] *was `[ ]`* (hard-coded `* 100`) | `api-worker/src/routes/quests.ts` claim uses `MICRO_USD_PER_COIN` |
| 1.4 | Exact BigInt math, no float rounding in splits | [x] | `shared/src/math/mlm.ts` (`calculateRewardSplit` BigInt + invariant check) |
| 1.5 | BigInt values survive JSON to the log server | [x] *was `[ ]`* (queue consumer `JSON.stringify` threw on BigInt, so every queued log was dropped) | `api-worker/src/utils/audit-logger.ts` `stringifyLog()` used by producer and consumer |

## 2. Revenue / reward split: 100 % of V (MSS §7, owner formula of 2026-11-23)

This replaces the earlier draft (5 % platform / 95 % net pool split 50/20/15/10/5). For every verified
reward or ad-revenue value **V**:

| Share | % of V | Goes to | When |
|---|---|---|---|
| Shooter / earner | **75 %** | Earner's wallet | Immediately |
| Upline L1 (direct) | **5 %** | Daily grey/green ledger, paid at midnight if the sponsor did 4 quests, else forfeited to the platform | Midnight settlement |
| Upline L2 | **4 %** | Same | Same |
| Upline L3 | **3 %** | Same | Same |
| Upline L4 | **2 %** | Same | Same |
| Upline L5 | **1 %** | Same | Same |
| Earner's head bounty | **5 %** | `wallets.bounty_micro_usd` of the **earner** (not withdrawable) | Claimed by whoever eliminates them, or by whoever opens their suicide / environmental-death bounty chest |
| Platform / system fee | **5 %** | Platform ledger (`PLATFORM_FEE` on `SYSTEM_PLATFORM`) | Immediately |
| **Total** | **100 %** | 75 + (5 + 4 + 3 + 2 + 1) + 5 + 5 | |

| # | Rule | Status | Where |
|---|---|---|---|
| 2.1 | Earner gets **75 %** of V | [x] | `REWARD_EARNER_BPS = 7500n`, `calculateRewardSplit()` in `packages/shared/src/math/mlm.ts`; credited by `applyRewardSplit()` in `api-worker/src/utils/reward-split.ts` |
| 2.2 | Uplines **L1 5 % · L2 4 % · L3 3 % · L4 2 % · L5 1 %** (15 % total) | [x] | `REWARD_UPLINE_BPS`; amounts go to `daily_mlm_pending_ledger` (MDU unlock rule still applies) |
| 2.3 | **5 %** onto the earner's own head bounty | [x] | `REWARD_BOUNTY_BPS = 500n`; `wallets.bounty_micro_usd` (migration `0006_head_bounty.sql`), logged as `BOUNTY_ACCRUE` |
| 2.4 | **5 %** platform / system fee | [x] | `REWARD_PLATFORM_BPS = 500n`, logged as `PLATFORM_FEE` |
| 2.5 | Missing upline levels roll over to the platform, so the total is always exactly 100 % of V | [x] | `unclaimedLevels` → `platformRolloverMicroUsd`; the invariant `earner + uplines + bounty + platform == V` throws if broken |
| 2.6 | Integer-division remainders (Micro-USD dust) also go to the platform | [x] | Rollover = V − every allocated share |
| 2.7 | Worked example V = 10,000,000 (10 USD): earner 7,500,000 · L1 500,000 · L2 400,000 · L3 300,000 · L4 200,000 · L5 100,000 · bounty 500,000 · platform 500,000 | [x] | `node packages/shared/scripts/verify-reward-split.js` (also checks partial uplines, no uplines, and rounding for odd amounts) |
| 2.8 | Applied to game kills, bounty chests and ad revenue | [x] | `routes/game.ts` (GAME_KILL / CHEST_OPEN), `routes/ads.ts` (AD_WATCH), both via `applyRewardSplit()` |
| 2.9 | Head bounty is claimed **in full** by the killer; a suicide / environmental death puts it into the bounty chest; an unopened or voided chest leaves it with its owner | [x] | Game server: `queueBountyClaim()`, `spawnDeathChest()`, `returnChestBounty()`; Worker: `BOUNTY_CLAIM` → `claimHeadBounty()` (compare-and-swap, so it can only be claimed once). Logged as `BOUNTY_PAYOUT` (victim) + `BOUNTY_CLAIM` (claimer, inflow) |
| 2.10 | No bounty claim on collusion kills, by guests, from yourself, or by flagged sessions | [x] | `ShootingRoom.queueBountyClaim()` checks paid seat, flags, ids |
| 2.11 | In-match HUD shows the credited 75 % and your current head bounty | [x] | `PlayerState.bountyMicroUsd` (seeded from the EC entry token), web HUD "Head Bounty" |
| 2.12 | The 5-level closure tree is built at signup and re-built when a referral is bought | [x] | `utils/mlm-tree.ts`, `routes/marketplace.ts` |
| 2.13 | The old 95 % net-pool function is no longer used for money | [x] | `calculateMlmDistribution()` is marked `@deprecated`; no route calls it |

**Ad revenue per country tier** (`routes/ads.ts`):

| Tier | Micro-USD | Coins |
|---|---|---|
| US | 50,000 | 500 |
| EU | 30,000 | 300 |
| TH | 10,000 | 100 |
| Other | 5,000 | 50 |

## 3. Daily Proof-of-Activity: quests and MLM unlock (MDU)

| # | Rule | Status | Where |
|---|---|---|---|
| 3.1 | At least **4 completed quests** a day unlock that day's downline commission | [x] | `DAILY_QUESTS_REQUIRED_TO_UNLOCK = 4`, `isUserMlmUnlocked()` |
| 3.2 | Commission is **grey** (pending) until unlocked, then **green** at once | [x] | `daily_mlm_pending_ledger.status`; `updateQuestProgress()` flips grey to green |
| 3.3 | Midnight UTC (07:00 Bangkok) settlement: green is credited to the wallet, grey is **forfeited** | [x] *was `[ ]`* (no cron trigger was configured) | `wrangler.toml [triggers] crons = ["0 0 * * *"]` and `scheduled()` in `src/index.ts` |
| 3.4 | Settlement only ever runs on **yesterday** (a finished day) | [x] *was `[ ]`* (the open endpoint settled "today" by default and could burn commission mid-day) | `authorizeSettlement()` + `yesterdayUtcDateKey()` |
| 3.5 | The settlement endpoint needs the internal secret | [x] *was `[ ]`* (anyone could trigger it) | `X-Internal-Secret` = `INTERNAL_API_SECRET` (open only in DEV_MOCK_MODE) |
| 3.6 | **Q_SPECTATE**: 90 s of ghost spectating, sent as 15 s heartbeats | [x] *was `[ ]`* (a client could send any increment, e.g. +90 at once) | `QuestProgressSchema.increment ≤ 15`; `last_progress_at` wall-clock limit (`SPECTATE_HEARTBEAT_SECONDS`); web sends +15 every 15 s |
| 3.7 | Q_PLAY_MATCH: play at least one arena match | [x] *was `[ ]`* (only counted when a payout happened, so a player with no kills never completed it) | Counted on `POST /api/game/enter` and on each batch payout |
| 3.8 | Q_WATCH_AD: 2 rewarded ads | [x] | Tracked server-side from the verified S2S postback |
| 3.9 | Q_DAILY_CHECKIN | [x] | `POST /api/quests/claim` or `progress` (+1 only) |
| 3.10 | Q_COMMUNITY: chat a downline **or open the network tree** | [x] *was `[ ]`* (opening the tree did not count) | `routes/chat.ts` and now `GET /api/network/downline` |
| 3.11 | Only timer and check-in quests can be self-reported; ads, matches, coins and community are server-tracked | [x] *was `[ ]`* (any quest could be completed from the browser) | `SELF_REPORTED_QUESTS` |
| 3.12 | Progress and claims always use the **server's** UTC date | [x] *was `[ ]`* (the client's `dateKey` was trusted, so past or future days could be completed) | `quests.ts` progress/claim |
| 3.13 | A quest reward is paid once, even under parallel requests | [x] *was `[ ]`* (two parallel claims both paid) | `is_claimed = 0` guard + `changes() = 1` in one D1 batch |
| 3.14 | Quest rewards are written to the audit ledger | [x] *was `[ ]`* (wallet credited with no log, so the Layer-1 check could never match) | `QUEST_REWARD` log |

## 4. Energy Tickets (EC)

| # | Rule | Status | Where |
|---|---|---|---|
| 4.1 | Maximum **6** tickets | [x] | `MAX_ENERGY_TICKETS = 6`; practice claims are capped at it |
| 4.2 | Recharge **1 ticket per hour** up to the cap | [x] | `routes/auth.ts /me` (`ENERGY_RECHARGE_SECONDS = 3600`) |
| 4.3 | **1 EC is spent** to enter a paid (cash) arena | [x] *was `[ ]`* (EC was never consumed anywhere) | `POST /api/game/enter`: atomic `energy_tickets >= 1` decrement, `arena_entries` row, `EC_CONSUME` log |
| 4.4 | When a full (6/6) wallet spends a ticket, the hourly recharge clock starts at that moment | [x] *was `[ ]`* | `CASE WHEN energy_tickets >= max …` in `/enter` |
| 4.5 | Practice / bot mode pays **zero cash and zero EC** (owner addendum 2026-11-23): bot kills, bot-mode chests → 0 EC, 0 Micro-USD | [x] | Web client no longer claims; `POST /api/practice/claim-ec` returns **410 Gone** |
| 4.6 | EC recharge comes **from ads only**: passive banner (Practice / Solo Bot + Ghost Spectator) reports 1 impression per 20 s of visible tab → EC % in proportion to the banner's value vs a 30 s video in that country; rewarded video 15 s = +50 %, 30 s = +100 % (1 EC) | [x] | `POST /api/ads/video/start` + `POST /api/ads/simulate-view`; `utils/ad-value.ts` `creditEcProgress` (10 000 bp = 1 EC, `users.energy_progress_bp`, migration 0007); `AD_EC_RECHARGE` log |
| 4.6a | Ad EC anti-abuse | [x] | Banner ≥ 18 s server gap per user; videos need a server-side session and the full 15/30 s before credit, credited once; 30 EC videos / user / UTC day |
| 4.7 | Only paid seats earn money in the arena | [x] *was `[ ]`* | The game server pays only sessions that joined with a valid signed entry token |

### 4b. Ad value engine (every ad event)

| Tier | Value used | Where |
|---|---|---|
| P1 | Exact network payout (`reward_usd` / `payout`, USD) → micro-USD | `resolveAdValue` (`utils/ad-value.ts`), postbacks pass `?reward_usd=` / `?payout=` and `?format=` |
| P2 | Yesterday's average network payout for the same `country_code` + `ad_format` | `ad_impressions` (`value_source='network'`) |
| P3 | Statistical country eCPM table: `round(ecpm_usd / 1000 × 1 000 000)` | `@mwar/shared` `getStatisticalAdMicroUsd` (Agy, `docs/AD_ECPM_BY_COUNTRY.md`); country = `request.cf.country` → `GLOBAL` |

Every ad event is logged in `ad_impressions` (purpose `ec_recharge` or `monetized`, value and value source). A "Monetized Ad Postback Test" (`purpose: 'monetized'`) runs the full 75 / 15 (5-4-3-2-1) / 5 / 5 split and is limited to admin / auditor accounts or local `wrangler dev`, because it mints wallet money.

## 5. Combat, chests and the game server (MSS §5)

| # | Rule | Status | Where |
|---|---|---|---|
| 5.1 | 20 Hz tick (50 ms), server-authoritative, room state in RAM, no DB on the game server | [x] | `GAME_TICK_INTERVAL_MS`, `setSimulationInterval`, `setPatchRate`; only Redis/RAM |
| 5.2 | Kill bounty **100,000 Micro-USD** ($0.10) | [x] | `KILL_REWARD_BASE_MICRO_USD` |
| 5.3 | Chests spawn **only** on suicide or non-player death (own grenade, fall, `/suicide`). Kills never drop chests, and there are no random chests. | [x] | `handlePlayerElimination()`; random spawner removed in Round 2 |
| 5.4 | Chest lifetime **15 s** | [x] | `CHEST_LIFETIME_MS = 15_000`, expiry in `update()` |
| 5.5 | A chest must be **shot** to open | [x] | `handleChestHit()` (30 HP) |
| 5.6 | The chest reward goes to the **top-damage dealer** | [x] *was `[ ]`* (the last hit got it) | `chestDamage` map; the winner is the highest total |
| 5.7 | Death-drop chest value = 2 × `CHEST_REWARD_BASE_MICRO_USD` (100,000) | [x] | `spawnDeathChest()` |
| 5.8 | Payouts are batched **every 10 s** to the Workers API, then D1 + Queue | [x] | `GAME_BATCH_SYNC_INTERVAL_MS = 10_000` |
| 5.9 | Batches are also flushed **when a player leaves** | [x] *was `[ ]`* (only on room dispose) | `onLeave()` calls `flushPayoutBatch()` |
| 5.10 | One bad batch item cannot block the whole batch | [x] *was `[ ]`* (a guest's non-UUID id failed validation and the batch was re-queued forever) | Envelope-level validation, per-item `BatchPayoutItemSchema`; guests are never queued |
| 5.11 | Player identity comes from a signed token, not from the client | [x] *was `[ ]`* (`options.userId` was trusted, so anyone could earn into any account) | `onAuth()` + `verifyEntryToken()` (HMAC-SHA256, 2 min expiry, single use) |
| 5.12 | The worker URL and secret come only from the server environment | [x] *was `[ ]`* (room options set by the first client could override them) | `ShootingRoom.onCreate` |
| 5.13 | Dead players can respawn on the server | [x] *was `[ ]`* (after the first death the server kept the player as a ghost, so their shots were ignored) | `player_respawn` message (≥ 3 s after death) |
| 5.14 | Grenade damage is computed on the server only | [x] *was `[ ]`* (the client also reported blast damage, so it counted twice) | `handleGrenadeExplosion()`; client reporting removed |

## 6. Anti-AFK (MSS §5.3)

| # | Rule | Status | Where |
|---|---|---|---|
| 6.1 | 5 min inactive: `AFK_WARNING` + 1-click captcha | [x] | `AFK_WARNING_SECONDS = 300`, `afk_warning` / `afk_captcha_solved` |
| 6.2 | 30 min inactive: kick | [x] | `AFK_KICK_SECONDS = 1800` |
| 6.3 | The round's earnings are **forfeited** to the platform | [x] *was `[ ]`* (only the message said so) | `forfeitRoundEarnings()`: unsent payouts are dropped; money already flushed gets an `AFK_FORFEIT` debit (never below 0) |

## 7. Anti-cheat (MSS §6)

| # | Rule | Status | Where |
|---|---|---|---|
| 7.1 | **Layer 1:** before payout, the D1 balance must equal the PostgreSQL 90-day ledger **exactly**. Any difference blocks the payout and alerts. | [x] *was `[ ]`* (approve did no check) | `routes/audit.ts layer1Check()` calls the log receiver `/api/logs/summary/:id`; a mismatch returns 409, records the reason and logs `[ADMIN ALERT]` |
| 7.2 | The ledger counts every wallet movement once | [x] *was `[ ]`* (MLM was logged at accrual, settlement and forfeit, so it counted up to 3×) | Accrual is `MLM_COMMISSION_PENDING` (not counted), settlement is `MLM_COMMISSION`, burn is `MLM_FORFEIT`. Inflow/outflow sets are shared: `LEDGER_INFLOW_ACTIONS` / `LEDGER_OUTFLOW_ACTIONS` |
| 7.3 | **Layer 2:** headshot ratio > **85 %** flags the account | [x] *was `[ ]`* | `HEADSHOT_RATIO_FLAG = 0.85` after `HEADSHOT_MIN_SAMPLE_HITS = 20`; a flagged session earns 0 |
| 7.4 | **Layer 2:** chest-collect rate > mean + **3σ** destroys the chest with no reward and marks the account | [x] *was `[ ]`* | `chestRateAnomalous()` (needs ≥ 4 other players as a sample) |
| 7.5 | **Layer 3:** same IP or device killing each other pays **0** | [x] *was `[ ]`* | `isCollusionKill()` (IP from `cf-connecting-ip`/`x-forwarded-for`, `deviceId` from localStorage) |
| 7.6 | Layer 3: the same killer→victim pair farmed repeatedly pays 0 | [x] *was `[ ]`* | More than 3 kills in 10 min pays 0 (`COLLUSION_*`) |
| 7.7 | Fire-rate limit per weapon | [x] *was `[ ]`* | `WEAPON_MIN_SHOT_INTERVAL_MS` with 20 % tolerance |
| 7.8 | Damage cannot exceed the weapon's damage (× head multiplier) | [x] *was `[ ]`* (any value up to 100 was accepted) | `player_shoot` clamp |
| 7.9 | Movement speed cap (anti-teleport) | [x] *was `[ ]`* | `player_move` rejects jumps over 20 m/s + 1.5 m |
| 7.10 | Admin withdrawal endpoints need admin/auditor | [x] *was `[ ]`* (`/api/audit/pending` and `/review` were public, so anyone could approve) | `requireAuditor` (open only in DEV_MOCK_MODE) |
| 7.11 | Password login brute-force limit | [x] *was `[ ]`* | 10 failures per account per 15 min (`login_failures`) |
| 7.12 | WhatsApp OTP is really verified in production | [x] *was `[ ]`* (any 6 digits were accepted outside dev mode) | Hashed `otp_codes`, 5 min TTL, 5 attempts, 60 s resend limit |
| 7.13 | Telegram login signature is checked in production | [x] *was `[ ]`* (the payload was trusted) | `verifyTelegramAuth()` with `TELEGRAM_BOT_TOKEN` |
| 7.14 | Ad S2S postbacks are authenticated and replay-proof | [x] *was `[ ]`* (anyone could call the postback URL with any user_id) | `AD_POSTBACK_SECRET` + `ad_postbacks (provider, tx_id)` primary key; `/dev/simulate-watch` works only in DEV_MOCK_MODE |

## 8. Wallet, withdrawals and marketplace

| # | Rule | Status | Where |
|---|---|---|---|
| 8.1 | Minimum withdrawal **$10 = 10,000,000 Micro-USD** | [x] | Zod `.min(10_000_000)` and D1 `CHECK (amount_micro_usd >= 10000000)` |
| 8.2 | Withdrawal fee **$0.50** (500,000 Micro-USD), net = amount − fee | [x] | `WITHDRAWAL_BASE_FEE_MICRO_USD`; `netPayoutMicroUsd` |
| 8.3 | A withdrawal can never overdraw or double-spend | [x] *was `[ ]`* (a failed conditional debit still inserted the request) | Debit + insert in one D1 transaction; the wallet `CHECK (balance >= 0)` aborts both |
| 8.4 | A rejected withdrawal is refunded and logged | [x] *was `[ ]`* (the dev simulation refunded without a log) | `CASHOUT_REJECT_REFUND` in both paths |
| 8.5 | Marketplace referral sale with a **30-day escrow** | [x] | `MARKETPLACE_ESCROW_DAYS = 30` |
| 8.6 | The seller is paid when the escrow is released | [x] *was `[ ]`* (the seller was never paid) | Cron `releaseMarketplaceEscrow()`, `escrow_released_at` guard, `MARKET_SELL` log |
| 8.7 | A listing cannot be sold twice and the buyer cannot overdraw | [x] *was `[ ]`* | `status='active'` update + `changes() = 1` debit in one batch, with the CHECK constraint |

## 9. Audit logging and retention (MSS §4, §8)

| # | Rule | Status | Where |
|---|---|---|---|
| 9.1 | Monthly tables **`logs_YYYY_MM`** | [x] *was `[ ]`* (hard-coded `logs_2026_11`) | `log-receiver tableFor(created_at)` |
| 9.2 | Audit rows are **immutable** (append-only) | [x] *was `[ ]`* | PostgreSQL triggers reject `UPDATE`, `DELETE` and `TRUNCATE`; `ON CONFLICT (transaction_id) DO NOTHING` makes delivery idempotent |
| 9.3 | Action types include GAME_KILL, CHEST_OPEN, AD_WATCH, MLM_COMMISSION, MARKET_BUY (+ CASHOUT_*, QUEST_REWARD, MARKET_SELL, AFK_FORFEIT, EC_CONSUME, MLM_COMMISSION_PENDING, MLM_FORFEIT, PRACTICE_EC_RECHARGE, AD_EC_RECHARGE, BOUNTY_ACCRUE, BOUNTY_CLAIM, BOUNTY_PAYOUT, PLATFORM_FEE) | [x] | `FinancialActionType` |
| 9.4 | `balance_after_micro_usd` holds the real balance | [x] *was `[ ]`* (mostly `0`) | `walletBalance()` after each wallet change |
| 9.5 | D1 is written first, then the log goes to the **Cloudflare Queue** | [x] | `logFinancialTransaction()` |
| 9.6 | The queue holds logs while the Mini PC is offline (up to **14 days**) and catches up FIFO | [x] *was `[ ]`* (there was no consumer binding, and messages were acked even when delivery failed) | `[[queues.consumers]]`; `ack()` only on HTTP 2xx, `retry()` with back-off; the receiver answers 503 to queue deliveries while PostgreSQL is down |
| 9.7 | Only the API worker can write to the log server | [x] *was `[ ]`* | `X-Log-Secret` = `LOG_RECEIVER_SECRET` (constant-time compare) |
| 9.8 | **90 days** in PostgreSQL, then gzip → **R2**, then the local table is dropped | [x] *was `[ ]`* | `archiveExpiredTables()` → `PUT /api/internal/log-archive/:name` → R2 `audit-archive/` (SHA-256 recorded). The table is dropped only after a successful upload. |
| 9.9 | The Layer-1 summary covers the 90-day window across monthly tables | [x] *was `[ ]`* | `tablesForWindow(90)` with `UNION ALL` |
| 9.10 | `chat_YYYY_MM` messages are deleted after **12 months** | [x] *was `[ ]`* | Cron deletes `direct_messages` older than `CHAT_RETENTION_MONTHS` |
| 9.11 | Logs reach `logs.mwar.win` through the Cloudflare Tunnel | [x] | `LOG_RECEIVER_URL = "https://logs.mwar.win/api/logs"` |

## 10. Web client (`apps/web`)

| # | Rule | Status | Where |
|---|---|---|---|
| 10.1 | Practice/bot HUD shows "EC ONLY" and no cash | [x] | `game/page.tsx` HUD |
| 10.2 | The spectator overlay counts 90 s and sends a heartbeat every 15 s | [x] | `game/page.tsx` spectate timer |
| 10.3 | Paid arena join spends 1 EC and passes the signed entry token and device id | [x] *was `[ ]`* | `initColyseus()` |
| 10.4 | Headshots are reported to the server for the Layer-2 ratio | [x] *was `[ ]`* | `player_shoot { headshot }` |
| 10.5 | Grey/green daily MLM display | [x] | `wallet/daily-mlm-summary` consumers |

---

## Operator steps (production activation, not code)

1. Apply the D1 migration:
   ```
   npx wrangler d1 migrations apply core_db --remote
   ```
   This adds migration `0005_economy_audit_fixes.sql`.
2. Create the R2 bucket once:
   ```
   npx wrangler r2 bucket create mwar-audit-archive
   ```
3. Set the queue retention to 14 days once:
   ```
   npx wrangler queues update mwar-financial-logs --message-retention-period-secs 1209600
   ```
4. Set the worker secrets with `npx wrangler secret put <NAME>`:
   - `INTERNAL_API_SECRET`, the same value as on the game server and the log receiver
   - `LOG_RECEIVER_SECRET`, the same value on the log receiver
   - `AD_POSTBACK_SECRET`, also put it in the ad network postback URL as `&secret=…`
   - `TELEGRAM_BOT_TOKEN`
5. Game server `.env`: set `INTERNAL_API_SECRET` and `WORKER_API_URL=https://api.mwar.win`. Log receiver `.env`: set `LOG_RECEIVER_SECRET`, `INTERNAL_API_SECRET` and `WORKER_API_URL`.
6. When testing is finished, change `DEV_MOCK_MODE = "true"` to `"false"` in `apps/api-worker/wrangler.toml`. Production currently runs with dev mode on, which keeps these open for the Dev Mock Panel:
   - faucet
   - open settlement
   - open audit review
   - fixed OTP `123456`
