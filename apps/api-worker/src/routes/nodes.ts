import { Hono } from 'hono';
import type { Env } from '../types';

export const nodesRouter = new Hono<{ Bindings: Env }>();

const DEFAULT_PROVISION_KEY = 'mwar_pvkey_237a3e447ee673a37f79cf2ab01524a1999b0098fd1e063b';

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

  const validMasterKey = c.env.NODE_PROVISION_KEY || DEFAULT_PROVISION_KEY;
  if (token === validMasterKey || token === c.env.INTERNAL_API_SECRET) {
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

  const role = (c.req.query('role') || 'all').toLowerCase();
  const rawNodeName = c.req.query('node_name') || 'mwar-game-server-1';
  const nodeName = rawNodeName.replace(/[^a-zA-Z0-9_-]/g, '');
  const tunnelToken = (c.req.query('tunnel_token') || '').trim();
  const internalSecret = c.env.INTERNAL_API_SECRET || 'local_internal_secret_2026';
  const apiBaseUrl = 'https://api.mwar.win';

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

# --- 1. System Dependencies ---
echo "[1/7] Installing base system utilities..."
apt-get update -y
apt-get install -y curl git build-essential ufw software-properties-common jq unzip

# --- 2. Database Services (PostgreSQL 16 & Redis) ---
if [ "${role}" = "all" ] || [ "${role}" = "game" ]; then
  echo "[2/7] Installing Redis Server for Colyseus state..."
  apt-get install -y redis-server
  systemctl enable redis-server
  systemctl restart redis-server
fi

if [ "${role}" = "all" ] || [ "${role}" = "logs" ]; then
  echo "[2/7] Installing PostgreSQL 16 for Audit Log Engine..."
  apt-get install -y postgresql postgresql-contrib
  systemctl enable postgresql
  systemctl restart postgresql

  echo "      Configuring database 'game_audit_logs' & user 'log_writer'..."
  sudo -u postgres psql -tc "SELECT 1 FROM pg_user WHERE usename = 'log_writer'" | grep -q 1 || \\
    sudo -u postgres psql -c "CREATE USER log_writer WITH PASSWORD 'local_dev_password_2026';"
  
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'game_audit_logs'" | grep -q 1 || \\
    sudo -u postgres psql -c "CREATE DATABASE game_audit_logs OWNER log_writer;"
  
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE game_audit_logs TO log_writer;"

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
  "
fi

# --- 3. Node.js 20 LTS, pnpm & PM2 ---
echo "[3/7] Setting up Node.js 20 LTS, pnpm, and PM2..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm install -g pnpm pm2

# --- 4. Cloudflare Tunnel Client (cloudflared) ---
echo "[4/7] Ensuring Cloudflare Tunnel (cloudflared) is installed..."
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb || apt-get install -f -y
  rm -f /tmp/cloudflared.deb
fi

# --- 5. Application Codebase & Build ---
echo "[5/7] Deploying application codebase to /opt/mwar-node..."
mkdir -p /opt/mwar-node
if [ ! -d "/opt/mwar-node/.git" ]; then
  git clone https://github.com/mmnnhla111/mwar.win.git /opt/mwar-node
else
  cd /opt/mwar-node
  git fetch origin main
  git reset --hard origin/main
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
LOG_PORT=3000
API_BASE_URL=${apiBaseUrl}
INTERNAL_API_SECRET=${internalSecret}
DATABASE_URL=postgresql://log_writer:local_dev_password_2026@localhost:5432/game_audit_logs
REDIS_URL=redis://127.0.0.1:6379
ENVEOF
chmod 600 /opt/mwar-node/.env

# --- 7. PM2 Process Launch & Auto-Boot On Reboot ---
echo "[7/7] Launching services under PM2 process manager..."
pm2 delete mwar-game-server 2>/dev/null || true
pm2 delete mwar-log-receiver 2>/dev/null || true
pm2 delete mwar-heartbeat 2>/dev/null || true

if [ "${role}" = "all" ] || [ "${role}" = "game" ]; then
  pm2 start /opt/mwar-node/apps/game-server/dist/index.js --name "mwar-game-server" --env PORT=2567
fi

if [ "${role}" = "all" ] || [ "${role}" = "logs" ]; then
  pm2 start /opt/mwar-node/apps/log-receiver/dist/index.js --name "mwar-log-receiver" --env PORT=3000
fi

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

  sleep 30
done
HEARTEOF
chmod +x /opt/mwar-node/heartbeat.sh
pm2 start /opt/mwar-node/heartbeat.sh --name "mwar-heartbeat" --interpreter bash

# Enable auto-start on server boot / power cycle
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

# Optional Cloudflare Tunnel auto-install
${tunnelToken ? `
echo "🔒 Configuring Cloudflare Tunnel service with provided token..."
cloudflared service install "${tunnelToken}" || true
systemctl enable cloudflared || true
systemctl restart cloudflared || true
` : '# No tunnel token specified; skip cloudflared service'}

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

  const validSecret = c.env.INTERNAL_API_SECRET || 'local_internal_secret_2026';
  const masterKey = c.env.NODE_PROVISION_KEY || DEFAULT_PROVISION_KEY;

  if (token !== validSecret && token !== masterKey) {
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
// 3. List All Nodes (GET /api/nodes)
// ----------------------------------------------------------------------------
nodesRouter.get('/', async (c) => {
  const masterKey = c.env.NODE_PROVISION_KEY || DEFAULT_PROVISION_KEY;

  const { results } = await c.env.DB
    .prepare(`
      SELECT 
        id, node_name, role, ip_address, region, cpu_usage, ram_usage,
        active_rooms, player_count, room_capacity_mini, room_capacity_fast,
        tunnel_hostname, last_heartbeat, created_at,
        CASE 
          WHEN last_heartbeat IS NOT NULL AND (unixepoch() - last_heartbeat) < 90 THEN 'online'
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
  });
});

// ----------------------------------------------------------------------------
// 4. Generate 1-Click Provision Command (POST /api/nodes/provision-command)
// ----------------------------------------------------------------------------
nodesRouter.post('/provision-command', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const role = (body.role || 'all').toLowerCase();
  const nodeName = (body.nodeName || 'mwar-game-server-1').replace(/[^a-zA-Z0-9_-]/g, '');
  const tunnelToken = (body.tunnelToken || '').trim();

  const masterKey = c.env.NODE_PROVISION_KEY || DEFAULT_PROVISION_KEY;

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
  });
});

// ----------------------------------------------------------------------------
// 5. Update Node Room Capacities (POST /api/nodes/:id/capacity)
// ----------------------------------------------------------------------------
nodesRouter.post('/:id/capacity', async (c) => {
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
