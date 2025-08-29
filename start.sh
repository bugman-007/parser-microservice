#!/bin/bash
# start.sh - PRODUCT STARTER (server + worker under PM2 or fallback)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [ -f .env.production ]; then
  export $(grep -v '^#' .env.production | xargs -d '\n' -I{} echo {})
fi

mkdir -p "${UPLOAD_DIR:-/opt/parser/uploads}" "${RESULT_DIR:-/opt/parser/results}"

if command -v pm2 >/dev/null 2>&1; then
  cat > ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [
    {
      name: "parser-server",
      script: "src/services/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "500M"
    },
    {
      name: "parser-worker",
      script: "src/services/worker.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "700M"
    }
  ]
}
EOF
  pm2 start ecosystem.config.cjs
  pm2 save
  echo "PM2 processes started and saved."
else
  echo "pm2 not found; starting plain node processes (nohup). Install pm2 for robustness."
  nohup node src/services/server.js > server.out 2>&1 &
  nohup node src/services/worker.js > worker.out 2>&1 &
fi
