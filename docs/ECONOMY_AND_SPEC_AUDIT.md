# Economy & Master Specification Audit

Audit of `apps/api-worker`, `apps/game-server`, `apps/log-receiver`, `apps/web` and `packages/shared`
against [`master_system_specification.md`](./master_system_specification.md) and
[`mlm_daily_unlock_engine.md`](./mlm_daily_unlock_engine.md).

- `[x]` = implemented and verified in code (file references given).
- `[ ]` = still open: not implemented, or it needs infrastructure / an owner decision. Each one says why.
- **FIXED (2026-11-23)** marks an item that was missing or wrong before this audit and is fixed in this change.

Verification run:

- `node packages/shared/scripts/verify-shared.js`: all MLM / currency tests pass, including the spec §7.2 worked example.
- `pnpm typecheck`: 5/5 projects clean.
- `pnpm --filter @mwar/web build`: clean.

---

## 1. Currency & accounting (spec §1.1-4)

- [x] All money is stored as **integer Micro-USD** (1 USD = 1,000,000). `MICRO_USD_PER_USD`, D1 `INTEGER` columns, PG `BIGINT` (`packages/shared/src/constants`, migrations).
- [x] **1 Coin = 100 Micro-USD** ($0.01 = 100 Coins): `MICRO_USD_PER_COIN`, `coinsToMicroUsd` / `microUsdToCoins` (`packages/shared/src/math/currency.ts`).
- [x] Wallet balance can never go negative: `CHECK (balance_micro_usd >= 0)` plus guarded `UPDATE … WHERE balance_micro_usd >= ?`.
- [x] **Minimum withdrawal $10.00** (10,000,000 Micro-USD): zod `WithdrawalCreateSchema.min(10_000_000)` and the D1 `CHECK`.
- [x] **Withdrawal fee $0.50** (`WITHDRAWAL_BASE_FEE_MICRO_USD`), recorded in `fee_micro_usd`. Net payout = amount − fee.
- [x] **FIXED**: the withdrawal debit is now guarded and runs before the request is inserted. Two concurrent requests can no longer both be recorded against one balance (`routes/wallet.ts`).
- [x] **FIXED**: marketplace purchase claims the listing atomically (`… AND status = 'active'`), then debits with a guard. If the debit fails, the claim is rolled back. A double purchase or a free purchase is no longer possible (`routes/marketplace.ts`).

## 2. MLM 5-level distribution: 5 % / 95 % (spec §7)

- [x] **Platform fee 5 %**, **net pool 95 %** of the transaction value V (`PLATFORM_FEE_PERCENT`, `NET_POOL_PERCENT`).
- [x] Net-pool split **L1 50 % · L2 20 % · L3 15 % · L4 10 % · L5 5 %** (`MLM_LEVEL_RATES`, sums to 100 %).
- [x] Spec §7.2 example: V = 10,000,000 gives fee 500,000, L1 4,750,000, L2 1,900,000, L3 1,425,000, L4 950,000, L5 475,000 (verified by `verify-shared.js`).
- [x] Missing upline levels and integer-division remainders go to the **Platform Reserve**. The invariant `fee + payouts + reserve == V` is enforced (`calculateMlmDistribution` throws if it is broken).
- [x] 5-level closure table `network_trees` (depth 1-5), rebuilt when a referral is bought on the marketplace (`utils/mlm-tree.ts`).
- [x] MLM applies to **game kills, bounty chests and ad watches** (`routes/game.ts`, `routes/ads.ts`).
- [x] **FIXED**: the Platform fee + reserve of every distribution is now written to the audit log (`PLATFORM_FEE` entry on account `SYSTEM_PLATFORM`). It is audit-only.
- [ ] **Owner decision: who pays the 95 %?** As literally written, spec §7.1 splits *V itself* (5 % platform + 95 % to the 5 uplines), which would leave the earning player with nothing. The code instead credits the player the full V and pays the upline commissions (computed on V with the same formula) on top, funded by the platform. This is a business decision, so the code is unchanged. Confirm which model you want.

## 3. Daily Proof-of-Activity MLM unlock (`mlm_daily_unlock_engine.md`)

- [x] Commissions go into `daily_mlm_pending_ledger` as **`pending_grey`**, and become **`unlocked_green`** once the sponsor completes **≥ 4 daily quests** (`DAILY_QUESTS_REQUIRED_TO_UNLOCK = 4`, `routes/quests.ts`).
- [x] Midnight settlement: unlocked amounts are credited to the wallet (`settled_paid`). Missed days are forfeited (`forfeited_burned`) and audit-logged.
- [x] Quest pool `Q_SPECTATE` (90 s), `Q_PLAY_MATCH`, `Q_WATCH_AD` (2 ads), `Q_DAILY_CHECKIN`, `Q_COMMUNITY`, `Q_EARN_COINS` (200 coins), seeded in migration 0002.
- [x] `Q_SPECTATE`: 90 s in Ghost Spectator, with a heartbeat to `/api/quests/progress` every 15 s (`apps/web/src/app/game/page.tsx`).
- [x] **FIXED**: the daily settlement now **runs automatically**. A Cloudflare Cron Trigger (`[triggers] crons = ["0 0 * * *"]` in `wrangler.toml`) plus a `scheduled()` handler settles **yesterday's** ledger at 00:00 UTC. Before this, no job existed and the default date was "today".
- [x] **FIXED**: both manual settlement endpoints (`/api/cron/settle-daily-mlm`, `/api/quests/settle-daily-mlm`) required **no authentication**, so anyone could trigger payouts early. They now require the `X-Internal-Secret` header.
- [x] **FIXED**: clients could POST progress for *any* quest, with any increment and any `dateKey`, which unlocked MLM instantly. Now only `Q_SPECTATE` (≤ 15 s per heartbeat) and `Q_DAILY_CHECKIN` can be reported by the client, always for today (UTC). Every other quest is tracked server-side from the real action. Quest claims are also limited to today.
- [x] **FIXED**: `Q_COMMUNITY` now also completes when the user views the network tree (`/api/network/downline`), as the spec requires. Before, only chat counted.
- [x] **FIXED**: `Q_PLAY_MATCH` now also completes when a practice round finishes (`/api/practice/claim-ec`). Before, it only counted when a multiplayer payout happened.
- [x] **FIXED**: quest coin rewards are now audit-logged (`QUEST_REWARD`, inflow).
- [ ] `Q_SPECTATE` is capped per heartbeat but not by server wall-clock time. A client could send 6 heartbeats quickly. A strict fix needs a `last_progress_at` column (new D1 migration).
- [ ] `Q_PLAY_MATCH` in **multiplayer** still only counts when the player earns a payout. The game server should report "match finished" for every player on leave. This needs a new internal endpoint.

## 4. Bounty chests & combat rules (spec §5.2, update 2026-11-22)

- [x] No random or pre-placed chests. A chest spawns **only** at the death spot of a **suicide / non-player death** (own grenade, fall, `/suicide`) (`ShootingRoom.handlePlayerElimination`, web `killPlayer`).
- [x] Killing another player **never** drops a chest. It drops the victim's weapon (5-minute despawn).
- [x] Chest lifetime **15 s** (`expiresAt = now + 15_000`, expired in the 20 Hz tick).
- [x] A chest must be **shot open**. The destroyer gets the reward, which is batched to the Worker.
- [x] **Practice / bot mode pays zero Micro-USD / coins**. It only gives Energy-Ticket recharge progress (client `awardPracticeProgress`, server `claim-ec` logs amount 0).
- [x] Kill bounty $0.10 (`KILL_REWARD_BASE_MICRO_USD`), death-drop chest $0.10 (2 × `CHEST_REWARD_BASE_MICRO_USD`).
- [x] **FIXED**: the Worker now **rejects batch payout items above the per-action cap** (kill ≤ $0.10, chest ≤ $0.10), unknown action types, and guest accounts (`routes/game.ts`).
- [x] **FIXED (identity)**: the game server trusted the `userId` sent by the client, so anyone could earn into any account. It now verifies the player's JWT through the Worker (`onAuth` → `/api/auth/me`). Unverified players are `guest_*` and never earn. The web client sends its token on join.
- [x] **FIXED (server authority)**: `player_shoot` now validates the weapon the shooter actually holds, caps damage at that weapon's `damage × headMult`, enforces a per-weapon fire-rate floor, and ignores shots from disguised (prop) players. Grenade damage to other players is computed **only on the server**. Before, the client also reported grenade damage, so it counted twice.

## 5. Real-time engine (spec §5.1)

- [x] Colyseus room, **20 Hz tick** (`GAME_TICK_INTERVAL_MS = 50`, `setSimulationInterval` + `setPatchRate`).
- [x] Game state lives in RAM, with Local Redis for room discovery only. **No PostgreSQL / DB on the game server.**
- [x] Payouts are batched **every 10 s** (`GAME_BATCH_SYNC_INTERVAL_MS`) to `/api/game/batch-payout`, using a shared secret (checked with a constant-time compare).
- [x] **FIXED**: payouts are also flushed **when a player leaves** (spec: "every 10 s *or* when the player leaves").
- [x] Player stance (`stand` / `crouch` / `prone`) is synced in state, so other clients render the right posture and hitbox.

## 6. Anti-AFK (spec §5.3)

- [x] **5 min** inactivity: `afk_warning` + one-click verification (`AFK_WARNING_SECONDS = 300`).
- [x] **30 min** inactivity: auto-kick (`AFK_KICK_SECONDS = 1800`).
- [x] **FIXED**: on an AFK kick, the player's **unflushed round earnings are forfeited** back to the system, and `sessionEarnings` is reset.

## 7. Anti-cheat tiers & withdrawals (spec §6)

- [x] **FIXED (Layer 1, deterministic)**: on a withdrawal request, the Worker fetches the PostgreSQL ledger (`/api/logs/summary/:userId`) and compares it with the D1 balance **to the exact Micro-USD**. If they match, the request goes to `ai_verifying` (score 1). If they don't match, or the log server is unreachable, it is held as `pending` for manual review, with the details stored in `audit_reasons`. Before, every request got a hard-coded score of 0.98.
- [x] **FIXED**: the withdrawal review endpoints (`/api/audit/pending`, `/api/audit/review`) had **no authentication**. Anyone could list users' emails or approve withdrawals. They now require an `admin` / `auditor` JWT.
- [x] Rejecting a withdrawal refunds the wallet (`CASHOUT_REJECT_REFUND`, now logged with the real balance).
- [x] Practice EC anti-cheat: ≥ 10 kills, ≥ 15 s per round, ≥ 15 s between claims.
- [ ] **Layer 2** (headshot ratio > 85 %, chest-collect rate > 3σ) is not implemented. It needs per-player hit statistics collected on the game server.
- [ ] **Layer 3** (ML network-graph collusion / kill-farming detection by IP / device fingerprint) is not implemented. This is a separate ML service.

## 8. Ads revenue (S2S postbacks)

- [x] Country-tier rewards: US $0.05 · EU $0.03 · TH $0.01 · other $0.005. The watcher is credited, and the 5-level MLM is calculated on the reward.
- [x] **FIXED**: the postback endpoints were **open to anyone**, so `GET /api/ads/postback/onclicka?user_id=X` minted money. They now require `?secret=ADS_POSTBACK_SECRET` (or the `X-Postback-Secret` header).
- [x] **FIXED**: `/api/ads/dev/simulate-watch` was unauthenticated, even in production. All money-minting dev helpers (ad simulation, wallet faucet, AI-review simulation) now only work on a local `wrangler dev` host, because `DEV_MOCK_MODE = "true"` is also set on the live Worker.
- [ ] Postback de-duplication (ad networks retry postbacks) needs a `postback_transactions` table keyed by the network's click/transaction id.

## 9. Energy Tickets (EC)

- [x] Max **6** tickets (`MAX_ENERGY_TICKETS`). Auto-recharge **1 ticket / hour** up to the cap (`/api/auth/me`).
- [x] Practice recharge: **+25 % per completed round** (4 rounds = 1 ticket), never above the cap (`routes/practice.ts`). It is audit-logged as `PRACTICE_EC_RECHARGE` (amount 0).
- [ ] **EC consumption** (spending a ticket to join a paid match) is not defined in the master spec and is not implemented. Decide the rule (e.g. 1 EC per paid-room join).

## 10. Immutable audit log → PostgreSQL (`logs.mwar.win`) (spec §3, §4.3, §8)

- [x] Every financial event is written to Cloudflare Queue `mwar-financial-logs`, then to the Fastify receiver over Cloudflare Tunnel, then to PostgreSQL. `transaction_id` is `UNIQUE` and inserts are `ON CONFLICT DO NOTHING`, so the log is append-only and idempotent.
- [x] **FIXED**: the Worker had a queue *producer* but **no consumer binding**, so the `queue()` handler never ran. `[[queues.consumers]]` has been added.
- [x] **FIXED**: the queue consumer **dropped** messages when the Mini PC was offline, and crashed on BigInt JSON. Failed deliveries are now retried with exponential back-off (up to 12 h apart, 60 retries ≈ 14+ days), BigInt values are serialized correctly, and successful deliveries are acked.
- [x] **FIXED**: logs went into a hard-coded `logs_2026_11` table forever. They now go to **monthly tables `logs_YYYY_MM`**, created on demand. The Layer-1 summary sums across every monthly table.
- [x] **FIXED**: the log receiver accepted writes from anyone who could reach `logs.mwar.win`. When `LOG_INGEST_SECRET` is set, every request must carry `X-Log-Secret` (the Worker sends it).
- [x] **FIXED (ledger correctness)**:
  - Earn-time upline commissions were logged as `MLM_COMMISSION` and then logged *again* at settlement, which double-counted them. They are now `MLM_PENDING` (audit-only).
  - Forfeits were logged as `MLM_COMMISSION` (an inflow). They are now `MLM_FORFEIT` (audit-only).
  - Marketplace seller proceeds (`MARKET_SALE`) and quest rewards (`QUEST_REWARD`) are now logged.
  - Every balance-changing entry records the **real `balance_after_micro_usd`**. Before, it was 0.
  - The ledger in/out lists are shared from one place: `LEDGER_INFLOW_ACTIONS` / `LEDGER_OUTFLOW_ACTIONS`.
- [ ] **90-day archive → gzip → R2 → drop table** (spec §8) is not implemented. It needs a cron job on the Mini PC with R2 credentials.
- [ ] **Queue retention 14 days** is a Cloudflare queue setting. Run `npx wrangler queues update mwar-financial-logs --message-retention-period-secs 1209600` (see "Owner actions").

## 11. Marketplace (spec §4.1 `marketplace_listings`)

- [x] Buying a referral moves the target user under the buyer and rebuilds the 5-level tree. 30-day warranty escrow (`MARKETPLACE_ESCROW_DAYS`).
- [x] **FIXED**: sellers were **never paid**. The buyer's money disappeared. The daily cron now releases matured escrow (`releaseMarketplaceEscrow`): the seller is credited the sale price and a `MARKET_SALE` entry is logged. This needs migration `0005_marketplace_escrow_release.sql`.
- [ ] Whether the platform takes a fee on marketplace sales is not specified. The code currently pays the full price to the seller.

## 12. Architecture & security (spec §1.1, §2, §3)

- [x] Core DB and chat run on Cloudflare D1, with no public DB ports. The web app is a static export on Cloudflare Workers.
- [x] Chat is partitioned monthly (`chat_YYYY_MM`).
- [ ] Spec says **Argon2id**. The Worker uses **PBKDF2-SHA256, 100k iterations**, because Workers have no native Argon2. Switching needs a WASM Argon2 library and a re-hash-on-login migration.
- [ ] Auto-deleting chat databases after 12 months, and R2 replay archives, are not implemented.
- [ ] `DEV_MOCK_MODE = "true"` is still set on the live Worker, because mock OTP login depends on it. The money endpoints are now locked to localhost, but turn it off once real OTP / Telegram login is live.

---

## Owner actions needed before / at deploy

```powershell
cd D:\Website\mwar-win\apps\api-worker
npx wrangler d1 migrations apply core_db --remote
npx wrangler secret put ADS_POSTBACK_SECRET
npx wrangler secret put LOG_INGEST_SECRET
npx wrangler queues update mwar-financial-logs --message-retention-period-secs 1209600
npx wrangler deploy
cd ..\web
npx wrangler deploy
```

- Append `&secret=<ADS_POSTBACK_SECRET>` to the AdswedMedia / OnClickA postback URLs.
- Put the same `LOG_INGEST_SECRET=<value>` in the Mini PC's `/opt/mwar-node/.env` and restart `mwar-log-receiver`.
- Redeploy the game server (`apps/game-server`) so token verification, the damage caps and the leave-flush go live. The game server's `WORKER_API_URL` must point at `https://api.mwar.win`.
