# Social hub redesign — deploy steps (2026-11-24)

Run from `D:\Website\mwar-win` after `git pull`. Order matters: database first, then API, then web.

## 1. D1 migrations (remote)

```bash
cd apps/api-worker
npx wrangler d1 migrations apply core_db --remote       # applies 0008_social_platform.sql
npx wrangler d1 migrations apply chat_2026_11 --remote  # applies 0002_unread_index.sql
```

`0008_social_platform.sql` adds profile columns on `users` (display_name, bio, cover_color, total_kills,
total_matches, followers/following/posts counters), the tables `social_posts`, `social_post_likes`,
`social_post_comments`, `social_follows`, `social_notifications`, `password_reset_tokens`, and their indexes.
It back-fills `total_matches` from `arena_entries`. Nothing is dropped.

## 2. API worker

```bash
cd apps/api-worker
npx wrangler secret put RESEND_API_KEY   # optional: enables password-reset emails (resend.com)
npx wrangler deploy
```

New vars in `wrangler.toml`: `GAME_SERVER_HTTP_URL`, `WEB_APP_URL`, `MAIL_FROM` (sender domain must be verified in Resend).
Without `RESEND_API_KEY` the forgot-password page still answers normally but no email is sent.

## 3. Game server (Mini PC)

The room lobby reads the new read-only `GET /rooms` on the game server (`https://game.mwar.win/rooms`).
Pull, rebuild and restart the game server so the endpoint exists; until then the lobby shows 0 players
and "Game server not reachable", and solo practice still works.

## 4. Web (Cloudflare Pages)

```bash
cd apps/web
pnpm run deploy:pages
```

## Quick check after deploy

- `https://mwar.win/` while signed out → redirects to `/login`
- `https://api.mwar.win/api/games` → JSON with `totalPlayers` / `onlineNow`
- `https://game.mwar.win/rooms` → JSON with `modes`

---

# Content policy + moderation round (2026-11-24, migration 0009)

Run in this order from `D:\Website\mwar-win` after `git pull`.

```bash
cd apps/api-worker
npx wrangler r2 bucket create mwar-media                 # new private bucket for post photos/videos
npx wrangler d1 migrations apply core_db --remote        # applies 0009_content_moderation.sql
npx wrangler deploy                                      # API: uploads, 18+ filter, reports, /api/moderation/*

cd ../web
pnpm run deploy:pages                                    # /settings, /report, admin takedown tab
```

`0009_content_moderation.sql` adds `users.show_nsfw`, the post columns `media_type`, `media_key`,
`content_rating`, `moderation_status`, `moderation_reason`, `nsfw_score`, `author_marked_nsfw`,
the tables `moderation_jobs` and `content_reports`, composite indexes, and rebuilds
`social_notifications` so it accepts the new `moderation` type (rows are copied, nothing is lost).
Existing posts stay `approved` / `safe`.

## Moderation node (Ubuntu 24.04 mini PC, as root)

```bash
curl -sSL "https://api.mwar.win/api/nodes/install.sh?token=<NODE_PROVISION_KEY>&role=moderator&node_name=mwar-mod-1" | sudo bash
curl -s http://127.0.0.1:3100/health
```

Needs the `INTERNAL_API_SECRET` secret on the API worker (already used by the game server).
Until a moderator node runs, new photo/video posts stay pending (visible only to their author).

## Security follow-up

The old hard-coded fallback provision key was removed from the code but is still in git history.
Rotate it: `npx wrangler secret put NODE_PROVISION_KEY` (new random value), then re-copy install
commands from Admin.

## Quick check

- Post a photo → it shows "กำลังตรวจสอบภาพ/วิดีโอ..." only for you; after the worker runs it becomes public, 18+ or rejected.
- `/settings` → 18+ toggle asks for age confirmation.
- Post "..." → แจ้งขอให้ลบ / Report → appears in Admin → คำขอแจ้งลบ (Takedown Requests).

---

# Multi-language round (2026-11-24, migration 0010)

```bash
cd apps/api-worker
npx wrangler d1 migrations apply core_db --remote        # applies 0010_preferred_lang.sql (and 0009 if not yet applied)
npx wrangler deploy                                      # bootstrap returns preferredLang; PATCH /api/social/settings saves it

cd ../web
pnpm run deploy:pages                                    # build runs the i18n key-parity check first
```

`0010_preferred_lang.sql` adds `users.preferred_lang TEXT NOT NULL DEFAULT 'en'`. Nothing else changes.

- Active languages: English, Thai, Indonesian, Vietnamese, Spanish. Chinese, Korean, Japanese, Hindi and
  Portuguese are reserved: add `apps/web/src/i18n/locales/<code>.json` and set `enabled: true` in
  `apps/web/src/i18n/config.ts`, then run `pnpm --filter @mwar/web i18n:check`.
- Language choice order: the user's pick on this device → the account's saved language → a supported browser
  language → the country from the device time zone (Thailand → Thai, Indonesia → Indonesian, Vietnam →
  Vietnamese, Spain / Latin America → Spanish) → English. No extra request is made.
- The in-game 3D HUD (`apps/web/src/game/**`) is not translated in this round.

## Telegram + LINE login round (migration 0011)

Accounts are opened only through Telegram or LINE (1 phone number = 1 account, no phone numbers stored).
Email sign-up (`POST /api/auth/register`) now answers 403; `/register` redirects to `/login` (keeps `?ref=`) and `/forgot-password` is gone.
Password login stays as a folded "backup password" option on `/login`.

1. Telegram: in @BotFather run `/setdomain` for the bot and enter `mwar.win`.
2. LINE: in the LINE Developers console create a **LINE Login** channel, add the callback URL
   `https://mwar.win/auth/callback/line`, and enable the `profile` + `openid` scopes.
3. Worker config (in `apps/api-worker`): uncomment `TELEGRAM_BOT_USERNAME` and `LINE_CHANNEL_ID` in `wrangler.toml`, then
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN      # if not set yet
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler d1 migrations apply core_db --remote   # 0011_social_oauth_accounts.sql
   npx wrangler deploy
   ```
4. Web: `pnpm run deploy:pages` (adds `/auth/callback/telegram`, `/auth/callback/line`, `/welcome`).

A provider whose settings are missing shows as "not available yet" on `/login` and the API answers 503 with setup steps.
Rules: username is generated at sign-up and can be chosen once (then locked); backup password can be changed once per 24 h;
switching Telegram/LINE in Settings replaces the old link; the last Telegram/LINE link cannot be removed.

## Earnings privacy, EC 1/30, map fix, admin members + game/room registry (migration 0012)

What changes:
- Head bounty is gone from `/profile` and the right sidebar; both show **Total earnings** with the owner's privacy mode
  (`public` → `$17,018.00`, `masked` → `$**,***.**`, `hidden` → "Not specified"). The API applies the mode
  (`/api/social/profile`, `/api/bootstrap`). The in-game HUD is unchanged.
- New accounts start with **1 EC**; the EC cap is **30** for everyone (the migration raises `max_energy_tickets` to 30).
- 30P Skirmish now uses the **240 m Metro Block** map; 100P Warzone keeps the 960 m Grand Valley.
- `/admin` gets **Members** (filters, inspector, EC ±, suspend, list orphans on the marketplace) and **Games & rooms**.
  Orphan sales are platform revenue (logged to `SYSTEM_PLATFORM`, no wallet credit).
- `/games` and the `/games/fps` lobby read the registry (`games`, `game_server_rooms`). The game server
  pulls `GET /api/games/rooms-config` every 60 s and hosts one `arena` room per room code.
- CORS now allows `PATCH` (earlier, browser PATCH calls such as Settings → 18+ were blocked).
- Favicon (`/favicon.ico`), app icons, web manifest and the MW$ logo (`/brand/*`).

Deploy (as Agy, in this order):
1. API worker
   ```bash
   cd apps/api-worker
   npx wrangler d1 migrations apply core_db --remote   # 0012_admin_games_and_earnings_privacy.sql
   npx wrangler deploy
   ```
2. Game server (Ubuntu node)
   ```bash
   cd /opt/mwar-node && git pull && pnpm install --frozen-lockfile
   pnpm --filter @mwar/shared build && pnpm --filter @mwar/game-server build
   # .env already has API_BASE_URL + NODE_ID from the installer (WORKER_API_URL also works)
   pm2 restart all     # or: systemctl restart mwar-game-server
   curl -s http://127.0.0.1:2567/health   # registryRooms should list TH-01, TH-02, TH-03
   ```
   Rooms pinned to a node are hosted only by the server whose `NODE_ID` equals that node's id or name;
   if it matches none, the server hosts every room.
3. Web: `pnpm run deploy:pages`

Quick check: `/settings` → "Total earnings visibility" switches the sidebar value; sidebar shows `1 / 30 EC` for a
new account; lobby TH-02 says Metro Block (240 m); `/admin` → Members → "No upline" lists orphans.

## EC cap 300, no passive EC, 55/15/5/5/20 split, "ให้กำลังใจ" Cheer (migration 0013, 2026-11-25)

What changes:
- **No passive / hourly EC regeneration anywhere.** New accounts start with `1 EC`; after that EC comes only from
  rewarded videos, banner impressions, Cheer ads or an admin adjustment.
- EC cap is **300** for everyone; every screen shows `X / 300 EC` (sidebars, profile, XSHOT lobby, admin inspector, HUD).
- Reward split of every V: **55 %** earner · **15 %** uplines (5/4/3/2/1) · **5 %** earner's head bounty ·
  **5 %** platform · **20 %** Energy Recharge Reserve Pool (`system_balances.energy_pool_micro_usd`).
  Missing upline tiers and rounding go to the platform; the sum is always exactly V.
- **ให้กำลังใจ (Cheer)** button on other players' posts, other players' profiles and the EC panels.
  Ads: 30 s video `+1 EC`, 15 s video `+50 % EC`, sponsored banner boost (10 s). Limits enforced in D1:
  45 s cooldown, 15 per user per UTC day, 3 per user per creator per day. Set `CHEER_DISABLED_FORMATS=banner`
  (Worker var) to hide the banner option when no sponsor is booked.
- Note: the ad shown in the Cheer modal is the built-in timed sponsor card (same simulation as the existing EC videos)
  until an ad-network SDK is wired in; the server still times and verifies every view.

Deploy (as Agy, in this order):
1. API worker
   ```bash
   cd apps/api-worker
   npx wrangler d1 migrations apply core_db --remote   # 0013_energy_cap_cheer_pool.sql
   npx wrangler deploy
   ```
   Check: `npx wrangler d1 execute core_db --remote --command "SELECT * FROM system_balances"` returns the `global` row.
2. Game server (Ubuntu node): only comments changed, but rebuild so the shared package matches
   ```bash
   cd /opt/mwar-node && git pull && pnpm install --frozen-lockfile
   pnpm --filter @mwar/shared build && pnpm --filter @mwar/game-server build
   pm2 restart all
   ```
3. Web: `pnpm run deploy:pages`

Quick check: a new account shows `1 / 300 EC` and stays at 1 after an hour; open any other player's post →
ให้กำลังใจ → the modal says `เหลือสิทธิ์วันนี้ 15/15 ครั้ง`; finish the 15 s video → `+50% EC`, counter 14/15.
`pnpm --filter @mwar/shared test` runs the split unit tests.
