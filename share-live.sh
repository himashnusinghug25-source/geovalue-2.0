#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

MODE="auto"
for arg in "$@"; do
  case "$arg" in
    --ssh) MODE="ssh" ;;
    --lt) MODE="lt" ;;
  esac
done

NEED_START=false
if ! lsof -nP -t -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 \
  || ! lsof -nP -t -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1 \
  || ! lsof -nP -t -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  NEED_START=true
fi

if $NEED_START; then
  echo "-> Starting GeoValue 2.0 services first..."
  ./start-geovalue.command --background --no-open
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")"
echo ""
echo "============================================================"
echo "  GeoValue 2.0 — Live Public Demo & Network Sharing         "
echo "============================================================"
echo "Local URL       : http://localhost:5173"
if [ -n "$LAN_IP" ]; then
  echo "Same Wi-Fi LAN  : http://${LAN_IP}:5173"
fi
echo ""

if [ "$MODE" = "auto" ] && command -v cloudflared >/dev/null 2>&1; then
  echo "-> Starting Cloudflare Quick Tunnel (zero-password public HTTPS URL)..."
  exec cloudflared tunnel --url http://localhost:5173
elif [ "$MODE" = "lt" ]; then
  echo "-> Starting LocalTunnel on port 5173..."
  exec npx --yes localtunnel --port 5173
else
  echo "-> Starting SSH Public Tunnel via localhost.run (zero-password public HTTPS URL)..."
  echo "   Wait a few seconds for the https://*.lhr.life link to appear below."
  echo "   (Optional: install 'brew install cloudflared' anytime for trycloudflare.com URLs)"
  echo ""
  # Keep stdin open cleanly so SSH works in both interactive terminals and background daemons
  while true; do sleep 60; done | exec ssh -T -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 80:localhost:5173 nokey@localhost.run
fi
