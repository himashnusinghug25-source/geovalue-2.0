#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

BACKGROUND=false
OPEN_BROWSER=true

for arg in "$@"; do
  case "$arg" in
    --background) BACKGROUND=true ;;
    --no-open) OPEN_BROWSER=false ;;
  esac
done

echo "============================================================"
echo "  GeoValue 2.0 — Pan-Delhi NCR Geospatial Risk & Valuation  "
echo "============================================================"
echo "Workspace : $ROOT_DIR"

mkdir -p .logs

echo "-> Freeing ports 3000, 8000, and 5173 if occupied..."
for port in 3000 8000 5173; do
  PIDS="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
  fi
done
sleep 1

echo "-> Starting Python FastAPI Risk & AHP Engine (port 8000)..."
(
  cd "$ROOT_DIR/python-risk-service"
  nohup ./.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > "$ROOT_DIR/.logs/python-risk.log" 2>&1 &
)

echo "-> Starting Node.js Spatial API (port 3000)..."
(
  cd "$ROOT_DIR/node-api"
  nohup node src/index.js > "$ROOT_DIR/.logs/node-api.log" 2>&1 &
)

echo "-> Starting React + Vite Frontend (port 5173)..."
(
  cd "$ROOT_DIR/react-client"
  nohup npm run dev -- --host 0.0.0.0 --port 5173 > "$ROOT_DIR/.logs/react-client.log" 2>&1 &
)

echo "-> Waiting for services to come online..."
READY_PY=false
READY_NODE=false
READY_UI=false

for _ in $(seq 1 20); do
  if ! $READY_PY && curl -sf "http://localhost:8000/health" >/dev/null 2>&1; then
    READY_PY=true
  fi
  if ! $READY_NODE && curl -sf "http://localhost:3000/health" >/dev/null 2>&1; then
    READY_NODE=true
  fi
  if ! $READY_UI && curl -sf "http://localhost:5173/" >/dev/null 2>&1; then
    READY_UI=true
  fi
  if $READY_PY && $READY_NODE && $READY_UI; then
    break
  fi
  sleep 0.5
done

echo ""
echo "Service Status:"
echo "  Python ML & AHP Engine : http://localhost:8000 (ready: $READY_PY)"
echo "  Node.js Spatial API    : http://localhost:3000 (ready: $READY_NODE)"
echo "  React 3D Map Client    : http://localhost:5173 (ready: $READY_UI)"
echo ""
echo "Logs stored in: $ROOT_DIR/.logs/"

if $OPEN_BROWSER; then
  echo "-> Opening http://localhost:5173 in Google Chrome..."
  open -a "Google Chrome" "http://localhost:5173" 2>/dev/null || open "http://localhost:5173" 2>/dev/null || true
fi

if ! $BACKGROUND; then
  echo ""
  echo "GeoValue 2.0 is running. Streaming service logs (press Ctrl+C to close log view; run ./stop-geovalue.command to stop servers)..."
  echo "------------------------------------------------------------"
  tail -n 15 -f "$ROOT_DIR/.logs/python-risk.log" "$ROOT_DIR/.logs/node-api.log" "$ROOT_DIR/.logs/react-client.log"
fi
