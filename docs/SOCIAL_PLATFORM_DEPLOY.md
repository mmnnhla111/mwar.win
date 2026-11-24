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
