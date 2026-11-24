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
