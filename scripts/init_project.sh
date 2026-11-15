#!/usr/bin/env bash
# ============================================================================
# GeoValue 2.0 — macOS Project Initialization Script
# File: scripts/init_project.sh
# Purpose: Initialize the unified GeoValue 2.0 monorepo directory structure,
#          PostgreSQL/PostGIS SQL workspace, Node.js API backend, and Python
#          FastAPI climate-risk microservice on macOS.
# ============================================================================

set -euo pipefail

PROJECT_ROOT="${1:-geovalue-2.0}"

echo ">>> Initializing GeoValue 2.0 workspace at: ${PROJECT_ROOT}"

# 1. Create unified root and service directories
mkdir -p "${PROJECT_ROOT}"/{database,scripts,node-api/src,python-risk-service/app}
cd "${PROJECT_ROOT}"

# 2. Initialize the Node.js API Backend
echo ">>> Initializing Node.js API backend (node-api)..."
pushd node-api >/dev/null
if [[ ! -f package.json ]]; then
    npm init -y >/dev/null
fi
npm install express pg cors dotenv
touch src/index.js .env.example .gitignore
popd >/dev/null

# 3. Initialize the Python FastAPI Microservice
echo ">>> Initializing Python FastAPI microservice (python-risk-service)..."
pushd python-risk-service >/dev/null
if [[ ! -d .venv ]]; then
    python3 -m venv .venv
fi
source .venv/bin/activate
python -m pip install --upgrade pip
cat <<'EOF' > requirements.txt
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
pydantic>=2.9.0
asyncpg>=0.29.0
shapely>=2.0.0
geoalchemy2>=0.15.0
EOF
pip install -r requirements.txt
deactivate
touch app/__init__.py app/main.py .env.example .gitignore
popd >/dev/null

# 4. Initialize the React + Vite Frontend (react-client)
echo ">>> Initializing React + Vite frontend (react-client)..."
if [[ ! -f react-client/package.json ]]; then
    npm create vite@latest react-client -- --template react
fi
pushd react-client >/dev/null
npm install mapbox-gl axios
touch .env.example .gitignore
popd >/dev/null

# 5. Create database migration placeholder if not present
touch database/01_municipal_parcels.sql

echo ">>> GeoValue 2.0 initialization complete."
find . -maxdepth 3 -not -path '*/node_modules*' -not -path '*/.venv*' | sort
