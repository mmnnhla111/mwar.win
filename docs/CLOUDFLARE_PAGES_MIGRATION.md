# Moving mwar.win static hosting from the `mwar-web` Worker to Cloudflare Pages

`apps/web` is a Next.js static export (`apps/web/out`). It used to be served by the Worker
`mwar-web` (`apps/web/wrangler.worker-legacy.toml`, a pass-through `env.ASSETS.fetch`). It is now
deployed to the Cloudflare Pages project **`mwar-web`**.

> Note: on Workers, requests that match a static asset are normally served without running the
> Worker script and are free. Pages is still the simpler fit for a pure static site (no script at
> all, preview URLs per branch, `_headers` for caching), so every page view stays off the Worker quota.

## 1. First Pages deploy (from Lah's PC, `apps/web`)

```powershell
git pull
cd apps\web
npx wrangler pages project create mwar-web --production-branch=main   # first time only
pnpm run deploy:pages        # = next build && wrangler pages deploy out --project-name=mwar-web --branch=main
```

Check https://mwar-web.pages.dev: it calls `https://api.mwar.win` and `wss://game.mwar.win`
(hostnames `mwar-web.pages.dev` and `*.mwar-web.pages.dev` are recognised in `lib/api.ts`).

## 2. Move the custom domains (Cloudflare dashboard)

1. **Workers & Pages → mwar-web (Worker) → Settings → Domains & Routes**: remove `mwar.win` and
   `www.mwar.win`.
2. **Workers & Pages → mwar-web (Pages) → Custom domains → Set up a custom domain**: add `mwar.win`,
   then `www.mwar.win`. The zone is on Cloudflare, so the DNS records are created automatically.
3. Open https://mwar.win and https://www.mwar.win and hard-refresh.

There are a few minutes between steps 1 and 2 where the domain is not served; do it at a quiet time.

## 3. Remove the old Worker (after the domains work on Pages)

```powershell
npx wrangler delete mwar-web -c wrangler.worker-legacy.toml
```

Until then, an emergency Worker redeploy is still possible with
`npx wrangler deploy -c wrangler.worker-legacy.toml`. The file was renamed on purpose so a plain
`npx wrangler deploy` in `apps/web` no longer re-claims the domains from Pages.

## 4. From now on

| What changed | Deploy command |
| --- | --- |
| `apps/web` | `cd apps\web; pnpm run deploy:pages` |
| `apps/api-worker` | `cd apps\api-worker; npx wrangler deploy` (unchanged) |
| game server | update on the Ubuntu node (unchanged) |
