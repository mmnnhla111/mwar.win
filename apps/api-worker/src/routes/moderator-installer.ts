/**
 * 1-click installer for a self-hosted moderation node (role=moderator), served by
 * GET /api/nodes/install.sh?token=<NODE_PROVISION_KEY>&role=moderator&node_name=mwar-mod-1
 *
 * Target: Ubuntu 24.04, CPU only (tuned for an Intel Core i3-8100T, 35 W, 8 GB RAM).
 * Installs python3 / venv / ffmpeg, the moderation worker venv with CPU-only PyTorch (model export
 * only) + ONNX Runtime + OpenVINO + NudeNet, pre-downloads/exports the models once, and runs
 * `mwar-nsfw-moderator` + a 180 s heartbeat under PM2 with auto-boot. Never touches other PM2 apps,
 * so it can also share a box with a game server.
 *
 * All interpolated values are validated by the caller (node name [A-Za-z0-9_-], threads 1..3).
 */
export function moderatorInstallScript(o: { nodeName: string; internalSecret: string; apiBaseUrl: string; threads: number }): string {
  const { nodeName, internalSecret, apiBaseUrl, threads } = o;
  return `#!/usr/bin/env bash
# ==============================================================================
# MWAR.WIN MODERATION NODE INSTALLER (role=moderator)
# Node Name : ${nodeName}
# Target OS : Ubuntu 24.04 LTS, CPU only (i3-8100T / 8 GB tuned: ${threads} worker threads)
# ==============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ Run as root: curl -sSL '<url>' | sudo bash" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=120"
ROOT=/opt/mwar-node
MOD=\${ROOT}/apps/moderation-worker
ENV_FILE=\${ROOT}/.env

echo "[1/7] System packages (python3, venv, ffmpeg)..."
\${APT} update -y
\${APT} install -y python3 python3-venv python3-pip ffmpeg git curl ca-certificates

echo "[2/7] Node.js + PM2 (process manager with auto-boot)..."
if ! command -v pm2 >/dev/null 2>&1; then
  if ! command -v npm >/dev/null 2>&1; then
    \${APT} install -y nodejs npm
  fi
  npm install -g pm2
fi

echo "[3/7] Code in \${ROOT}..."
if [ -d "\${ROOT}/.git" ]; then
  cd "\${ROOT}"
  git remote set-url origin https://github.com/mmnnhla111/mwar.win.git || true
  git fetch origin main --prune
  git reset --hard origin/main
else
  rm -rf "\${ROOT}"
  git clone --depth 1 https://github.com/mmnnhla111/mwar.win.git "\${ROOT}"
fi
test -f "\${MOD}/worker.py" || { echo "❌ \${MOD}/worker.py missing (is main up to date?)" >&2; exit 1; }

echo "[4/7] Python venv (CPU-only wheels, no CUDA downloads)..."
python3 -m venv "\${MOD}/.venv"
PIP="\${MOD}/.venv/bin/pip"
\${PIP} install --upgrade pip wheel
# torch / torchvision only from the CPU index (used once to export CLIP to ONNX)
\${PIP} install torch torchvision --index-url https://download.pytorch.org/whl/cpu
\${PIP} install --extra-index-url https://download.pytorch.org/whl/cpu -r "\${MOD}/requirements.txt"

echo "[5/7] Writing \${ENV_FILE} (existing keys of other roles are kept)..."
touch "\${ENV_FILE}"
chmod 600 "\${ENV_FILE}"
set_env() {
  if grep -q "^$1=" "\${ENV_FILE}"; then
    sed -i "s|^$1=.*|$1=$2|" "\${ENV_FILE}"
  else
    echo "$1=$2" >> "\${ENV_FILE}"
  fi
}
set_env INTERNAL_API_SECRET "${internalSecret}"
set_env API_URL "${apiBaseUrl}"
set_env MOD_CPU_THREADS "${threads}"
set_env MOD_NODE_NAME "${nodeName}"
set_env MOD_HEALTH_PORT "3100"

echo "[6/7] Downloading + exporting models once (CLIP -> ONNX, text prompts, NudeNet v3)..."
cd "\${MOD}"
OMP_NUM_THREADS=${threads} MKL_NUM_THREADS=${threads} OPENBLAS_NUM_THREADS=${threads} MOD_CPU_THREADS=${threads} \\
  "\${MOD}/.venv/bin/python" prepare_models.py

echo "[7/7] PM2: mwar-nsfw-moderator + heartbeat (180 s)..."
HB_NAME=mwar-heartbeat
if pm2 jlist 2>/dev/null | grep -q '"name":"mwar-game-server"'; then
  HB_NAME=mwar-heartbeat-moderator   # keep the game server's own heartbeat untouched
fi

cat << 'HEARTEOF' > "\${ROOT}/heartbeat-moderator.sh"
#!/usr/bin/env bash
set -a; source /opt/mwar-node/.env; set +a
while true; do
  CPU_LOAD=$(top -bn1 | grep "Cpu(s)" | awk '{print $2 + $4}' || echo "0.0")
  RAM_LOAD=$(free -m | awk '/Mem:/ { printf("%.1f", ($3/$2) * 100) }' || echo "0.0")
  IP=$(hostname -I | awk '{print $1}')
  curl -s -X POST "\${API_URL}/api/nodes/heartbeat" \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer \${INTERNAL_API_SECRET}" \\
    -d "{\\"nodeId\\":\\"\${MOD_NODE_NAME}\\",\\"nodeName\\":\\"\${MOD_NODE_NAME}\\",\\"role\\":\\"moderator\\",\\"cpuUsage\\":\${CPU_LOAD:-0},\\"ramUsage\\":\${RAM_LOAD:-0},\\"activeRooms\\":0,\\"playerCount\\":0,\\"ipAddress\\":\\"\${IP}\\",\\"tunnelHostname\\":\\"\\"}" >/dev/null 2>&1 || true
  sleep 180
done
HEARTEOF
chmod +x "\${ROOT}/heartbeat-moderator.sh"

cat << ECOEOF > "\${ROOT}/ecosystem.moderator.config.cjs"
module.exports = {
  apps: [
    {
      name: "mwar-nsfw-moderator",
      script: "\${MOD}/worker.py",
      interpreter: "\${MOD}/.venv/bin/python",
      cwd: "\${MOD}",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "1500M",
      env: {
        MWAR_ENV_FILE: "\${ENV_FILE}",
        MOD_CPU_THREADS: "${threads}",
        OMP_NUM_THREADS: "${threads}",
        OPENBLAS_NUM_THREADS: "${threads}",
        MKL_NUM_THREADS: "${threads}",
        ORT_NUM_THREADS: "${threads}",
        PYTHONUNBUFFERED: "1"
      }
    },
    {
      name: "\${HB_NAME}",
      script: "\${ROOT}/heartbeat-moderator.sh",
      interpreter: "bash",
      cwd: "\${ROOT}",
      autorestart: true,
      restart_delay: 5000
    }
  ]
};
ECOEOF

pm2 delete mwar-nsfw-moderator "\${HB_NAME}" >/dev/null 2>&1 || true
pm2 start "\${ROOT}/ecosystem.moderator.config.cjs"
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

echo "      Waiting for http://127.0.0.1:3100/health (model load ~10-40 s)..."
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:3100/health >/dev/null 2>&1; then
    echo ""
    curl -fsS http://127.0.0.1:3100/health; echo ""
    echo "✅ Moderation node ${nodeName} is running (pm2 logs mwar-nsfw-moderator)"
    exit 0
  fi
  sleep 3
done
echo "❌ Health check failed. Recent logs:" >&2
pm2 logs mwar-nsfw-moderator --lines 40 --nostream || true
exit 1
`;
}
