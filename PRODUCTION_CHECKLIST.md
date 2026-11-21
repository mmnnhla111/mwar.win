# MWAR.WIN Production Operations & Deployment Guide

This guide provides complete instructions for managing the live production environment on `mwar.win`, switching from Mock/Testing mode to production integrations, connecting the Ubuntu Mini PC via Cloudflare Tunnel, and enabling Cloudflare R2 storage.

---

## 1. Live Architecture Overview

| Component | Technology | Live URL / Binding | Status |
| :--- | :--- | :--- | :--- |
| **Web Frontend** | Next.js 15 (Static Export) + Three.js | `https://mwar.win`<br>`https://www.mwar.win`<br>`https://mwar-web.pages.dev` | 🟢 **LIVE** |
| **Core API Worker** | Cloudflare Workers + Hono | `https://api.mwar.win` | 🟢 **LIVE** |
| **Core Database** | Cloudflare D1 (APAC) | `core_db`<br>`3c539f8e-7a45-4415-9b72-d335787e15f0` | 🟢 **LIVE** |
| **Chat Database** | Cloudflare D1 (APAC) | `chat_2026_11`<br>`4b626ea0-91ab-4266-ae22-8f6fbfb61190` | 🟢 **LIVE** |
| **Financial Log Queue** | Cloudflare Queues | `mwar-financial-logs` | 🟢 **LIVE** |
| **Game Server** | Colyseus v0.15 (RAM Engine) | `wss://game.mwar.win` *(Falls back to Offline Practice Mode if unlinked)* | 🟡 *Ready for Tunnel* |
| **Log Receiver** | Fastify + PostgreSQL 16 | `https://logs.mwar.win/api/logs` *(Buffered safely by Queue & D1)* | 🟡 *Ready for Tunnel* |

---

## 2. Switching to Production (`DEV_MOCK_MODE="false"`)

The system currently runs with `DEV_MOCK_MODE="true"` so you can test registration, login, daily quests, and mock transactions immediately without external API credentials.

### Step 2.1: Add Real Production Secrets
Run the following commands from the root directory to store your API keys securely in Cloudflare:

```powershell
cd apps/api-worker
$env:CLOUDFLARE_ACCOUNT_ID="00a674bee4124645524f4aabe22ac68c"

# Telegram Bot Token
npx wrangler secret put TELEGRAM_BOT_TOKEN

# WhatsApp Cloud API / BSP Token & Phone Number ID
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID

# NOWPayments API Key & IPN Secret
npx wrangler secret put NOWPAYMENTS_API_KEY
npx wrangler secret put NOWPAYMENTS_IPN_SECRET

# Ad Network S2S Postback Secrets
npx wrangler secret put AD_POSTBACK_SECRET
```

### Step 2.2: Disable Dev Mock Mode & Redeploy
In `apps/api-worker/wrangler.toml`, change:
```toml
[vars]
DEV_MOCK_MODE = "false"
```

Then deploy the worker:
```powershell
npx wrangler deploy
```

---

## 3. Connecting Ubuntu Mini PC via Cloudflare Tunnel (`cloudflared`)

The Ubuntu Mini PC hosts the authoritative **PostgreSQL 16 audit database** (`logs_YYYY_MM`) and the **Colyseus 20Hz Game Server** (`mini_30` / `fast_100`). Cloudflare Tunnel securely connects your home machine to the public internet without port forwarding.

### Step 3.1: Install `cloudflared` on Ubuntu
```bash
# Download and install cloudflared deb package
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Authenticate with your Cloudflare account
cloudflared tunnel login
```
*(Select your `mwar.win` domain from the web page prompt)*

### Step 3.2: Create the Tunnel
```bash
cloudflared tunnel create mwar-tunnel
# Note down the generated Tunnel UUID (e.g., d5a1e2f3-...)
```

### Step 3.3: Configure the Ingress Rules
Create `/home/ubuntu/.cloudflared/config.yml`:
```yaml
tunnel: <YOUR-TUNNEL-UUID>
credentials-file: /home/ubuntu/.cloudflared/<YOUR-TUNNEL-UUID>.json

ingress:
  # 1. Colyseus Game Server (WebSocket with HTTP Fallback)
  - hostname: game.mwar.win
    service: http://localhost:2567
    originRequest:
      noTLSVerify: true
      tcpKeepAlive: 30s

  # 2. Financial Log Receiver (Fastify + PostgreSQL)
  - hostname: logs.mwar.win
    service: http://localhost:3001
    originRequest:
      noTLSVerify: true

  # Default Catch-all rule (required)
  - service: http_status:404
```

### Step 3.4: Route DNS to the Tunnel
```bash
cloudflared tunnel route dns mwar-tunnel game.mwar.win
cloudflared tunnel route dns mwar-tunnel logs.mwar.win
```

### Step 3.5: Run Tunnel as a Background Service
```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
sudo systemctl status cloudflared
```

---

## 4. Enabling Cloudflare R2 Storage (Avatars & Game Assets)

1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **R2 Object Storage** in the sidebar.
3. Click **Get Started** or **Enable R2** (accept the Terms of Service).
4. Run the following command locally:
   ```powershell
   cd apps/api-worker
   $env:CLOUDFLARE_ACCOUNT_ID="00a674bee4124645524f4aabe22ac68c"
   npx wrangler r2 bucket create mwar-assets
   ```
5. In `apps/api-worker/wrangler.toml`, uncomment:
   ```toml
   [[r2_buckets]]
   binding = "ASSETS_BUCKET"
   bucket_name = "mwar-assets"
   ```
6. Redeploy: `npx wrangler deploy`.

---

## 5. Daily Maintenance & Useful Commands

| Action | Command |
| :--- | :--- |
| **Run All Services Locally** | `pnpm dev:all` |
| **Run Daily Quest Assertions** | `node scripts/test-daily-quests.js` |
| **Typecheck Full Monorepo** | `pnpm typecheck` |
| **Tail Live API Worker Logs** | `cd apps/api-worker; npx wrangler tail` |
| **Trigger Daily MLM Settlement (Cron)** | `curl -X POST https://api.mwar.win/api/cron/settle-daily-mlm -H "Content-Type: application/json"` |
| **Build & Deploy Web App** | `pnpm --filter @mwar/web build; cd apps/web; npx wrangler deploy` |
| **Deploy API Worker** | `cd apps/api-worker; npx wrangler deploy` |
