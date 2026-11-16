#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "Stopping GeoValue 2.0 services on ports 3000, 8000, and 5173..."
ALL_PIDS=""
for port in 3000 8000 5173; do
  PIDS="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
    ALL_PIDS="$ALL_PIDS $PIDS"
  fi
done
if [ -n "${ALL_PIDS// /}" ]; then
  echo "Stopped service PIDs:$ALL_PIDS"
else
  echo "No active GeoValue 2.0 servers found on ports 3000, 8000, or 5173."
fi

pkill -f "cloudflared tunnel --url http://localhost:5173" 2>/dev/null || true
pkill -f "localtunnel --port 5173" 2>/dev/null || true
pkill -f "nokey@localhost.run" 2>/dev/null || true

echo "All GeoValue 2.0 processes stopped cleanly."
