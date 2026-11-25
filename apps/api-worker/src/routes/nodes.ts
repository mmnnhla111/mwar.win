import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AuthUserPayload } from '../types';
import { requireStaff, staffHas } from '../middleware/staff';
import { isLocalDev, safeEqual } from '../utils/guards';
import { moderatorInstallScript } from './moderator-installer';

const NODE_ROLES = ['all', 'game', 'logs', 'moderator'];

export const nodesRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

/** Server fleet: super_admin / admin (local `wrangler dev` without a token stays open for the Dev Mock Panel). */
const requireAdminOrAuditor = requireStaff('nodes');

/**
 * Validate incoming provisioning or node secret
 */
async function validateProvisionKey(c: any): Promise<boolean> {
  const authHeader = c.req.header('Authorization') || '';
  const token =
    authHeader.replace(/^Bearer\s+/i, '').trim() ||
    c.req.header('X-Provision-Key') ||
    c.req.query('token') ||
    '';

  if (!token) return false;

  const validMasterKey = c.env.NODE_PROVISION_KEY;
  if ((validMasterKey && safeEqual(token, validMasterKey)) || (c.env.INTERNAL_API_SECRET && safeEqual(token, c.env.INTERNAL_API_SECRET))) {
    return true;
  }

  // Check per-node revocable tokens in D1
  const node = await c.env.DB
    .prepare('SELECT id FROM game_nodes WHERE provision_token = ?1')
    .bind(token)
    .first();

  return !!node;
}

// ----------------------------------------------------------------------------
// 1. Authenticated Installer Shell Script (GET /api/nodes/install.sh)
// ----------------------------------------------------------------------------
nodesRouter.get('/install.sh', async (c) => {
  const isAuthorized = await validateProvisionKey(c);
  if (!isAuthorized) {
    return c.text('❌ 401 Unauthorized: Invalid or missing Provisioning Key. Access Denied.\n', 401);
  }

  // Whitelisted values only: everything below is interpolated into a script that runs as root
  const role = (c.req.query('role') || 'all').toLowerCase();
  if (!NODE_ROLES.includes(role)) return c.text(`❌ 400: role must be one of ${NODE_ROLES.join(', ')}\n`, 400);
  const rawNodeName = c.req.query('node_name') || (role === 'moderator' ? 'mwar-mod-1' : 'mwar-game-server-1');
  const nodeName = rawNodeName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'mwar-node';
  const tunnelToken = (c.req.query('tunnel_token') || '').trim().replace(/[^A-Za-z0-9=_.-]/g, '');
  // No hardcoded fallback: refuse to generate an installer without the real secret
  const internalSecret = c.env.INTERNAL_API_SECRET || '';
  if (!internalSecret) return c.text('❌ 503: INTERNAL_API_SECRET is not configured on the API worker.\n', 503);
  const logReceiverSecret = c.env.LOG_RECEIVER_SECRET || c.env.LOG_INGEST_SECRET || internalSecret;
  const apiBaseUrl = 'https://api.mwar.win';

  if (role === 'moderator') {
    const threads = Math.max(1, Math.min(3, Math.floor(Number(c.req.query('threads') || 2)) || 2));
    return c.text(moderatorInstallScript({ nodeName, internalSecret, apiBaseUrl, threads }), 200, { 'Cache-Control': 'no-store' });
  }

  const script = `#!/usr/bin/env bash
# ==============================================================================
# MWAR.WIN 1-CLICK AUTHENTICATED SERVER PROVISIONING ENGINE
# Node Name : ${nodeName}
# Target OS : Ubuntu 24.04 LTS (Bare-Metal / VPS)
# Role      : ${role}
# Timestamp : $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ==============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ Error: This provisioning script must be executed as root (use: sudo bash)." >&2
  exit 1
fi

echo ""
echo "=================================================================="
echo "  🚀 STARTING MWAR.WIN NODE PROVISIONING: ${nodeName}"
echo "  Role Architecture: ${role}"
echo "=================================================================="
echo ""

export DEBIAN_FRONTEND=noninteractive

# --- 0. Self-Healing: Auto-Repair Broken dpkg / apt States (Power Loss / Interrupted Install Recovery) ---
echo "      Checking package manager state and recovering interrupted dpkg runs..."
BROKEN_PKGS=$(dpkg -l 2>/dev/null | awk '/^[a-z]H|^[a-z]R|^[a-z][a-z]R/ {print $2}' || true)
if [ -n "\${BROKEN_PKGS}" ]; then
  echo "      Found broken / reinstreq package(s): \${BROKEN_PKGS}. Force-removing..."
  for pkg in \${BROKEN_PKGS}; do
    dpkg --remove --force-remove-reinstreq "\${pkg}" 2>/dev/null || true
  done
fi
dpkg --configure -a 2>/dev/null || true
apt-get install -f -y -o DPkg::Lock::Timeout=120 2>/dev/null || true

# --- 1. System Dependencies ---
echo "[1/7] Installing base system utilities..."
apt-get -o DPkg::Lock::Timeout=120 update -y
apt-get -o DPkg::Lock::Timeout=120 install -y curl git build-essential ufw software-properties-common jq unzip tar

# --- 2. Database Services (PostgreSQL 16 & Redis) ---
if [ "${role}" = "all" ] || [ "${role}" = "game" ]; then
  echo "[2/7] Installing Redis Server for Colyseus state..."
  apt-get -o DPkg::Lock::Timeout=120 install -y redis-server
  systemctl enable redis-server
  systemctl restart redis-server
fi

if [ "${role}" = "all" ] || [ "${role}" = "logs" ]; then
  echo "[2/7] Configuring PostgreSQL 16 for Audit Log Engine..."
  apt-get -o DPkg::Lock::Timeout=120 install -y postgresql postgresql-contrib
  systemctl enable postgresql
  systemctl restart postgresql

  echo "      Configuring database 'game_audit_logs' & user 'log_writer' (idempotent)..."
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='log_writer'" 2>/dev/null | grep -q 1; then
    sudo -u postgres psql -c "CREATE USER log_writer WITH PASSWORD 'local_dev_password_2026';" || true
  else
    sudo -u postgres psql -c "ALTER USER log_writer WITH PASSWORD 'local_dev_password_2026';" || true
  fi

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='game_audit_logs'" 2>/dev/null | grep -q 1; then
    sudo -u postgres psql -c "CREATE DATABASE game_audit_logs OWNER log_writer;" || true
  else
    echo "      Database 'game_audit_logs' already exists."
    sudo -u postgres psql -c "ALTER DATABASE game_audit_logs OWNER TO log_writer;" || true
  fi

  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE game_audit_logs TO log_writer;" || true

  echo "      Applying financial logs schema..."
  sudo -u postgres psql -d game_audit_logs -c "
    CREATE TABLE IF NOT EXISTS logs_2026_11 (
      id BIGSERIAL PRIMARY KEY,
      transaction_id VARCHAR(64) UNIQUE NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      action_type VARCHAR(32) NOT NULL,
      amount_micro_usd BIGINT NOT NULL,
      balance_after_micro_usd BIGINT NOT NULL,
      source_game_id VARCHAR(64),
      related_user_id VARCHAR(36),
      mlm_level INT CHECK (mlm_level BETWEEN 1 AND 5),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_logs_user_date ON logs_2026_11(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_action ON logs_2026_11(action_type);
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO log_writer;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO log_writer;
  " || true
fi

# --- 3. Node.js 20 LTS, pnpm & PM2 ---
echo "[3/7] Setting up Node.js 20 LTS, pnpm, and PM2..."
export PATH="/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  echo "      Attempting NodeSource repository install (with retry & IPv4)..."
  NODE_SETUP_OK=0
  set +e
  curl -4 -fsSL --retry 5 --retry-delay 3 https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null
  if [ $? -eq 0 ]; then
    apt-get -o DPkg::Lock::Timeout=120 install -y nodejs 2>/dev/null
    if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v20* ]]; then
      NODE_SETUP_OK=1
    fi
  fi
  set -e

  if [ "\${NODE_SETUP_OK}" -eq 0 ]; then
    echo "⚠️ NodeSource setup failed or reset connection. Falling back to official nodejs.org binary tarball..."
    set +e
    TAR_NAME=$(curl -4 -fsSL --retry 5 --retry-delay 3 https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt 2>/dev/null | grep 'linux-x64\.tar\.gz$' | head -n 1 | awk '{print $2}')
    if [ -z "\${TAR_NAME}" ]; then
      TAR_NAME="node-v20.20.2-linux-x64.tar.gz"
    fi
    echo "      Downloading https://nodejs.org/dist/latest-v20.x/\${TAR_NAME}..."
    curl -4 -fsSL --retry 5 --retry-delay 3 "https://nodejs.org/dist/latest-v20.x/\${TAR_NAME}" -o /tmp/node-v20.tar.gz
    if [ -f /tmp/node-v20.tar.gz ]; then
      echo "      Extracting Node.js binary tarball to /usr/local..."
      tar -xzf /tmp/node-v20.tar.gz -C /usr/local --strip-components=1
      rm -f /tmp/node-v20.tar.gz
    fi
    set -e
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Error: Failed to install Node.js 20. Please check internet connection." >&2
  exit 1
fi

echo "      Node.js version: $(node -v), npm version: $(npm -v)"
echo "      Installing pnpm & pm2 globally..."
npm install -g pnpm pm2 || true
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable 2>/dev/null || npm install -g pnpm
fi

# --- 4. Cloudflare Tunnel Client (cloudflared) ---
echo "[4/7] Ensuring Cloudflare Tunnel (cloudflared) is installed..."
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -4 -fsSL --retry 5 --retry-delay 3 -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb || true
  if [ -f /tmp/cloudflared.deb ]; then
    dpkg -i /tmp/cloudflared.deb || apt-get -o DPkg::Lock::Timeout=120 install -f -y
    rm -f /tmp/cloudflared.deb
  fi
fi

# --- 5. Application Codebase & Build ---
echo "[5/7] Deploying application codebase to /opt/mwar-node..."
if [ -d "/opt/mwar-node/.git" ]; then
  echo "      Existing repository detected at /opt/mwar-node. Syncing with origin/main..."
  cd /opt/mwar-node
  git remote set-url origin https://github.com/mmnnhla111/mwar.win.git || true
  git fetch origin main --prune
  git reset --hard origin/main
  git clean -fd -e .env -e ecosystem.config.cjs
else
  echo "      Fresh clone into /opt/mwar-node..."
  rm -rf /opt/mwar-node
  git clone https://github.com/mmnnhla111/mwar.win.git /opt/mwar-node
  cd /opt/mwar-node
fi

cd /opt/mwar-node
pnpm install

echo "      Building packages & services..."
pnpm --filter @mwar/shared build

if [ "${role}" = "all" ] || [ "${role}" = "game" ]; then
  pnpm --filter @mwar/game-server build
fi

if [ "${role}" = "all" ] || [ "${role}" = "logs" ]; then
  pnpm --filter @mwar/log-receiver build
fi

# --- 6. Configuration & Environment ---
echo "[6/7] Writing environment configuration (/opt/mwar-node/.env)..."
cat << 'ENVEOF' > /opt/mwar-node/.env
NODE_ENV=production
NODE_ID=${nodeName}
NODE_ROLE=${role}
PORT=2567
GAME_PORT=2567
LOG_PORT=3000
API_BASE_URL=${apiBaseUrl}
INTERNAL_API_SECRET=${internalSecret}
LOG_RECEIVER_SECRET=${logReceiverSecret}
LOG_INGEST_SECRET=${logReceiverSecret}
DATABASE_URL=postgresql://log_writer:local_dev_password_2026@localhost:5432/game_audit_logs
REDIS_URL=redis://127.0.0.1:6379
ENVEOF
chmod 600 /opt/mwar-node/.env

# Background Heartbeat Daemon (reports CPU, RAM, active rooms every 30s)
cat << 'HEARTEOF' > /opt/mwar-node/heartbeat.sh
#!/usr/bin/env bash
source /opt/mwar-node/.env
while true; do
  CPU_LOAD=$(top -bn1 | grep "Cpu(s)" | awk '{print $2 + $4}' || echo "0.0")
  RAM_LOAD=$(free -m | awk '/Mem:/ { printf("%.1f", ($3/$2) * 100) }' || echo "0.0")
  
  ROOMS=0
  PLAYERS=0
  if [ "${role}" != "logs" ]; then
    HEALTH_DATA=$(curl -s http://127.0.0.1:2567/health 2>/dev/null || echo "{}")
  fi

  IP=$(curl -s https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

  curl -s -X POST "${apiBaseUrl}/api/nodes/heartbeat" \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer ${internalSecret}" \\
    -d "{
      \\"nodeId\\": \\"${nodeName}\\",
      \\"nodeName\\": \\"${nodeName}\\",
      \\"role\\": \\"${role}\\",
      \\"cpuUsage\\": \${CPU_LOAD:-0.0},
      \\"ramUsage\\": \${RAM_LOAD:-0.0},
      \\"activeRooms\\": \${ROOMS:-0},
      \\"playerCount\\": \${PLAYERS:-0},
      \\"ipAddress\\": \\"\${IP}\\",
      \\"tunnelHostname\\": \\"game.mwar.win\\"
    }" >/dev/null 2>&1 || true

  sleep 180
done
HEARTEOF
chmod +x /opt/mwar-node/heartbeat.sh

# --- 7. PM2 Ecosystem Configuration & Launch ---
echo "[7/7] Generating PM2 ecosystem configuration (/opt/mwar-node/ecosystem.config.cjs)..."

cat << 'ECOSYSTEM_HEAD' > /opt/mwar-node/ecosystem.config.cjs
module.exports = {
  apps: [
ECOSYSTEM_HEAD

if [ "${role}" = "all" ] || [ "${role}" = "game" ]; then
cat << ECOSYSTEM_GAME >> /opt/mwar-node/ecosystem.config.cjs
    {
      name: "mwar-game-server",
      script: "./apps/game-server/dist/index.js",
      cwd: "/opt/mwar-node",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: "production",
        PORT: 2567,
        GAME_PORT: 2567,
        REDIS_URL: "redis://127.0.0.1:6379",
        API_BASE_URL: "${apiBaseUrl}",
        INTERNAL_API_SECRET: "${internalSecret}",
        LOG_RECEIVER_SECRET: "${logReceiverSecret}",
        NODE_ID: "${nodeName}",
        NODE_ROLE: "${role}"
      }
    },
ECOSYSTEM_GAME
fi

if [ "${role}" = "all" ] || [ "${role}" = "logs" ]; then
cat << ECOSYSTEM_LOGS >> /opt/mwar-node/ecosystem.config.cjs
    {
      name: "mwar-log-receiver",
      script: "./apps/log-receiver/dist/index.js",
      cwd: "/opt/mwar-node",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        LOG_PORT: 3000,
        DATABASE_URL: "postgresql://log_writer:local_dev_password_2026@localhost:5432/game_audit_logs",
        API_BASE_URL: "${apiBaseUrl}",
        INTERNAL_API_SECRET: "${internalSecret}",
        LOG_RECEIVER_SECRET: "${logReceiverSecret}",
        LOG_INGEST_SECRET: "${logReceiverSecret}",
        NODE_ID: "${nodeName}",
        NODE_ROLE: "${role}"
      }
    },
ECOSYSTEM_LOGS
fi

cat << ECOSYSTEM_TAIL >> /opt/mwar-node/ecosystem.config.cjs
    {
      name: "mwar-heartbeat",
      script: "./heartbeat.sh",
      interpreter: "bash",
      cwd: "/opt/mwar-node",
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        API_BASE_URL: "${apiBaseUrl}",
        INTERNAL_API_SECRET: "${internalSecret}",
        LOG_RECEIVER_SECRET: "${logReceiverSecret}",
        NODE_ID: "${nodeName}",
        NODE_ROLE: "${role}"
      }
    }
  ]
};
ECOSYSTEM_TAIL

echo "      Starting services via PM2 ecosystem..."
pm2 delete all 2>/dev/null || true
pm2 start /opt/mwar-node/ecosystem.config.cjs
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save || true

# Optional Cloudflare Tunnel auto-install
${tunnelToken ? `
echo "🔒 Configuring Cloudflare Tunnel service with provided token..."
cloudflared service uninstall 2>/dev/null || true
cloudflared service install "${tunnelToken}" || true
systemctl enable cloudflared || true
systemctl restart cloudflared || true
` : '# No tunnel token specified; skip cloudflared service'}

# --- Mandatory Health Verification ---
echo "      Waiting 5 seconds for service warm-up and health verification..."
sleep 5

VERIFY_FAILED=0

if [ "${role}" = "all" ] || [ "${role}" = "game" ]; then
  echo "      Checking mwar-game-server on http://127.0.0.1:2567/health..."
  if curl -fsS http://127.0.0.1:2567/health >/dev/null 2>&1; then
    echo "      ✅ mwar-game-server is HEALTHY (port 2567 responding)"
  else
    echo "      ❌ mwar-game-server FAILED healthcheck on port 2567!" >&2
    VERIFY_FAILED=1
  fi
fi

if [ "${role}" = "all" ] || [ "${role}" = "logs" ]; then
  echo "      Checking mwar-log-receiver on http://127.0.0.1:3000/health..."
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "      ✅ mwar-log-receiver is HEALTHY (port 3000 responding)"
  else
    echo "      ❌ mwar-log-receiver FAILED healthcheck on port 3000!" >&2
    VERIFY_FAILED=1
  fi
fi

if [ "\${VERIFY_FAILED}" -ne 0 ]; then
  echo ""
  echo "❌ INSTALLATION VERIFICATION FAILED! Dumping PM2 error logs:" >&2
  pm2 logs --err --lines 30 --nostream || true
  exit 1
fi

# Send immediate initial registration heartbeat
IP_ADDR=$(curl -s https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
curl -s -X POST "${apiBaseUrl}/api/nodes/heartbeat" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${internalSecret}" \\
  -d "{
    \\"nodeId\\": \\"${nodeName}\\",
    \\"nodeName\\": \\"${nodeName}\\",
    \\"role\\": \\"${role}\\",
    \\"cpuUsage\\": 5.0,
    \\"ramUsage\\": 15.0,
    \\"activeRooms\\": 0,
    \\"playerCount\\": 0,
    \\"ipAddress\\": \\"\${IP_ADDR}\\",
    \\"tunnelHostname\\": \\"game.mwar.win\\"
  }" >/dev/null 2>&1 || true

echo ""
echo "=================================================================="
echo "  🎉 SUCCESS: NODE ${nodeName} PROVISIONED AND ONLINE!"
echo "  Colyseus Game Server : ws://localhost:2567"
echo "  PostgreSQL Log Server: http://localhost:3000"
echo "  Heartbeat Monitor    : Active every 30s -> https://api.mwar.win"
echo "  PM2 Auto-Boot        : Configured for system reboots"
echo "=================================================================="
echo ""
`;

  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Content-Disposition': 'inline; filename="install.sh"',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
});

// ----------------------------------------------------------------------------
// 2. Node Heartbeat Ping (POST /api/nodes/heartbeat)
// ----------------------------------------------------------------------------
nodesRouter.post('/heartbeat', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  const validSecret = c.env.INTERNAL_API_SECRET || '';
  const masterKey = c.env.NODE_PROVISION_KEY || '';

  // No hardcoded fallback secret: an unset secret rejects every heartbeat
  if (!token || ((!validSecret || !safeEqual(token, validSecret)) && (!masterKey || !safeEqual(token, masterKey)))) {
    return c.json({ error: 'Unauthorized node heartbeat' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const nodeId = body.nodeId || body.node_id || 'mwar-game-server-1';
  const nodeName = body.nodeName || body.node_name || nodeId;
  const role = body.role || 'all';
  const cpuUsage = Number(body.cpuUsage ?? body.cpu_usage ?? 0.0);
  const ramUsage = Number(body.ramUsage ?? body.ram_usage ?? 0.0);
  const activeRooms = Number(body.activeRooms ?? body.active_rooms ?? 0);
  const playerCount = Number(body.playerCount ?? body.player_count ?? 0);
  const ipAddress = body.ipAddress || body.ip_address || null;
  const tunnelHostname = body.tunnelHostname || body.tunnel_hostname || 'game.mwar.win';

  await c.env.DB
    .prepare(`
      INSERT INTO game_nodes (
        id, node_name, role, status, ip_address, cpu_usage, ram_usage,
        active_rooms, player_count, tunnel_hostname, last_heartbeat
      )
      VALUES (?1, ?2, ?3, 'online', ?4, ?5, ?6, ?7, ?8, ?9, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        node_name = excluded.node_name,
        role = excluded.role,
        status = 'online',
        ip_address = COALESCE(excluded.ip_address, game_nodes.ip_address),
        cpu_usage = excluded.cpu_usage,
        ram_usage = excluded.ram_usage,
        active_rooms = excluded.active_rooms,
        player_count = excluded.player_count,
        tunnel_hostname = COALESCE(excluded.tunnel_hostname, game_nodes.tunnel_hostname),
        last_heartbeat = unixepoch()
    `)
    .bind(nodeId, nodeName, role, ipAddress, cpuUsage, ramUsage, activeRooms, playerCount, tunnelHostname)
    .run();

  return c.json({
    success: true,
    nodeId,
    status: 'online',
    timestamp: Date.now(),
  });
});

// ----------------------------------------------------------------------------
// 3. List All Nodes (GET /api/nodes) - Protected: Admin / Auditor Only
// ----------------------------------------------------------------------------
nodesRouter.get('/', requireAdminOrAuditor, async (c) => {
  // The provisioning key is admin-only (auditors see node telemetry, never the key)
  const masterKey = isLocalDev(c) || (await staffHas(c, 'nodes')) ? c.env.NODE_PROVISION_KEY || '' : '';

  const { results } = await c.env.DB
    .prepare(`
      SELECT 
        id, node_name, role, ip_address, region, cpu_usage, ram_usage,
        active_rooms, player_count, room_capacity_mini, room_capacity_fast,
        tunnel_hostname, last_heartbeat, created_at,
        CASE 
          WHEN last_heartbeat IS NOT NULL AND (unixepoch() - last_heartbeat) < 420 THEN 'online'
          ELSE 'offline'
        END AS status
      FROM game_nodes
      ORDER BY created_at ASC
    `)
    .all();

  return c.json({
    nodes: results || [],
    provisionKey: masterKey,
    timestamp: Date.now(),
  }, 200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
});

// ----------------------------------------------------------------------------
// 4. Generate 1-Click Provision Command (POST /api/nodes/provision-command) - Protected
// ----------------------------------------------------------------------------
nodesRouter.post('/provision-command', requireAdminOrAuditor, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const role = String(body.role || 'all').toLowerCase();
  if (!NODE_ROLES.includes(role)) return c.json({ error: `role must be one of ${NODE_ROLES.join(', ')}` }, 400);
  const nodeName = String(body.nodeName || (role === 'moderator' ? 'mwar-mod-1' : 'mwar-game-server-1')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const tunnelToken = String(body.tunnelToken || '').trim().replace(/[^A-Za-z0-9=_.-]/g, '');

  const masterKey = c.env.NODE_PROVISION_KEY || '';

  let url = `https://api.mwar.win/api/nodes/install.sh?token=${masterKey}&role=${encodeURIComponent(role)}&node_name=${encodeURIComponent(nodeName)}`;
  if (tunnelToken) {
    url += `&tunnel_token=${encodeURIComponent(tunnelToken)}`;
  }

  const command = `curl -sSL "${url}" | sudo bash`;

  return c.json({
    command,
    provisionKey: masterKey,
    nodeName,
    role,
    tunnelConfigured: !!tunnelToken,
  }, 200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
});

// ----------------------------------------------------------------------------
// 5. Update Node Room Capacities (POST /api/nodes/:id/capacity) - Protected
// ----------------------------------------------------------------------------
nodesRouter.post('/:id/capacity', requireAdminOrAuditor, async (c) => {
  const nodeId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const mini = Number(body.room_capacity_mini || 30);
  const fast = Number(body.room_capacity_fast || 100);

  await c.env.DB
    .prepare(`
      UPDATE game_nodes 
      SET room_capacity_mini = ?1, room_capacity_fast = ?2 
      WHERE id = ?3
    `)
    .bind(mini, fast, nodeId)
    .run();

  const node = await c.env.DB
    .prepare('SELECT * FROM game_nodes WHERE id = ?1')
    .bind(nodeId)
    .first();

  return c.json({
    success: true,
    node,
  });
});
