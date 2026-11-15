# GeoValue 2.0 — Spatial Database & Project Architecture Guide

**GeoValue 2.0** is a real-time climate risk and property valuation platform organized as a unified single-folder monorepo. It pairs a **PostgreSQL/PostGIS** spatial data tier with a **Node.js API backend** (valuation gateway & client APIs) and a **Python FastAPI microservice** (climate hazard scoring & geospatial analytics).

---

## Unified Project Structure

All database migrations, initialization automation, and microservices live inside one root directory (`geovalue-2.0/`):

```text
geovalue-2.0/
├── README.md                        # Master architecture & setup document
├── database/
│   └── 01_municipal_parcels.sql     # Step 1: PostGIS schema & GiST index
├── scripts/
│   └── init_project.sh              # Step 2: Automated macOS initialization script
├── node-api/                        # Node.js API backend (valuation gateway)
│   ├── package.json
│   ├── .env.example
│   ├── .gitignore
│   └── src/
│       └── index.js
├── python-risk-service/             # Python FastAPI microservice (climate risk engine)
│   ├── requirements.txt
│   ├── .env.example
│   ├── .gitignore
│   └── app/
│       ├── __init__.py
│       └── main.py
└── react-client/                    # Vite + React + Mapbox GL JS frontend
    ├── package.json
    ├── vite.config.js
    ├── index.html
    ├── .env.example
    ├── .gitignore
    └── src/
        ├── main.jsx
        ├── App.jsx
        └── App.css
```

---

## Step 1: PostgreSQL / PostGIS Spatial Schema (`database/01_municipal_parcels.sql`)

The `municipal_parcels` table stores cadastral boundaries, benchmark government valuation rates (`circle_rate`), and real-time composite climate hazard indices (`risk_score`).

```sql
-- 1. Enable PostGIS spatial capabilities (idempotent)
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Create the municipal_parcels table
CREATE TABLE IF NOT EXISTS municipal_parcels (
    id          BIGSERIAL PRIMARY KEY,
    parcel_id   VARCHAR(64) NOT NULL UNIQUE,
    circle_rate NUMERIC(14, 2) NOT NULL CHECK (circle_rate >= 0),
    risk_score  NUMERIC(5, 2) NOT NULL DEFAULT 0.00
                    CHECK (risk_score >= 0 AND risk_score <= 100),
    geom        geometry(MultiPolygon, 4326) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Enforce OGC-valid geometries to prevent spatial index/overlay errors
    CONSTRAINT chk_municipal_parcels_geom_valid CHECK (ST_IsValid(geom))
);

-- 3. Create GiST spatial index on the WGS 84 MultiPolygon geometry column
CREATE INDEX IF NOT EXISTS idx_municipal_parcels_geom
    ON municipal_parcels
    USING GIST (geom);

-- 4. Update PostgreSQL query planner statistics for spatial selectivity
ANALYZE municipal_parcels;
```

### Spatial Engineering Notes

- **SRID `4326` (WGS 84)**: Standardizes coordinates in longitude/latitude degrees (`EPSG:4326`) for seamless GeoJSON ingestion and interoperability with external climate hazard layers and web mapping clients.
- **`MultiPolygon` Geometry**: Safely accommodates split parcels, right-of-way easements, and multi-tract municipal lots without failing type constraints on single polygons (wrap single polygons with `ST_Multi(geom)` on insert).
- **GiST Index (`USING GIST (geom)`)**: Builds an R-Tree-over-GiST bounding-box index, accelerating spatial predicates (`ST_Intersects`, `ST_Contains`, `ST_DWithin`) from $O(N)$ sequential scans to logarithmic lookups.
- **Exact Precision & Constraints**: Uses `NUMERIC(14, 2)` for monetary `circle_rate` and bounded `NUMERIC(5, 2)` (`0`–`100`) for `risk_score`, avoiding floating-point rounding drift. `ST_IsValid(geom)` guards against self-intersecting rings before rows enter the spatial index.

---

## Step 2: macOS Terminal Bash Commands to Initialize the Project

Run the following commands in **macOS Terminal** (`zsh` or `bash`) to scaffold the entire `geovalue-2.0` monorepo, initialize the **Node.js API backend**, and configure the **Python FastAPI microservice** inside isolated environments.

### A. One-Shot Terminal Commands

```bash
# 1. Create the unified project root and subdirectories
mkdir -p geovalue-2.0/{database,scripts,node-api/src,python-risk-service/app}
cd geovalue-2.0

# 2. Initialize the Node.js API backend (node-api)
cd node-api
npm init -y
npm install express pg cors dotenv
touch src/index.js .env.example .gitignore
cd ..

# 3. Initialize the Python FastAPI microservice (python-risk-service)
cd python-risk-service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install fastapi "uvicorn[standard]" pydantic asyncpg shapely geoalchemy2
pip freeze > requirements.txt
deactivate
touch app/__init__.py app/main.py .env.example .gitignore
cd ..

# 4. Initialize the React + Vite Frontend (react-client)
npm create vite@latest react-client -- --template react
cd react-client
npm install mapbox-gl axios
cp .env.example .env
cd ..

# 5. Create the PostGIS schema file and verify directory layout
touch database/01_municipal_parcels.sql
find . -maxdepth 3 -not -path '*/node_modules*' -not -path '*/.venv*' | sort
```

### B. Automated Script Execution

The exact initialization workflow is also saved in `scripts/init_project.sh` and can be executed directly:

```bash
chmod +x scripts/init_project.sh
./scripts/init_project.sh geovalue-2.0
```

---

## Running Locally on macOS (Quick Start)

1. **Apply the PostGIS Schema** (assuming PostgreSQL + PostGIS is running locally via Homebrew or Docker):
   ```bash
   createdb geovalue
   psql -d geovalue -f database/01_municipal_parcels.sql
   ```
2. **Start the Node.js API Backend**:
   ```bash
   cd node-api
   cp .env.example .env
   npm install
   npm run dev
   ```
3. **Start the Python FastAPI Microservice**:
   ```bash
   cd python-risk-service
   cp .env.example .env
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   uvicorn app.main:app --reload --port 8000
   ```

---

## Node.js API Endpoints (`node-api/src/index.js`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Verifies API and PostGIS database connectivity (`PostGIS_Version()`). |
| `GET` | `/api/tiles/:z/:x/:y.mvt` | Streams dynamic Mapbox Vector Tiles (`application/vnd.mapbox-vector-tile`) from `municipal_parcels` using `ST_TileEnvelope`, `ST_AsMVTGeom`, and `ST_AsMVT` (returns `204 No Content` on empty tiles). Also serves `.pbf`. |
| `GET` | `/v1/parcels/lookup?lon=&lat=` | Looks up parcel valuation (`circle_rate`) and `risk_score` at a WGS 84 coordinate. |

---

## Python FastAPI Risk Service Endpoints (`python-risk-service/app/main.py`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Liveness probe for the FastAPI climate risk microservice. |
| `POST` | `/predict/risk` | Accepts `{ parcel_id, circle_rate, distance_to_hazard }` and returns `{ parcel_id, risk_score, risk_adjusted_valuation }` using a simulated XGBoost/RandomForest spatial decay & tree-split ensemble. |

---

## React Frontend (`react-client/`)

Run the Vite development server on port `5173`:

```bash
cd react-client
cp .env.example .env   # Add VITE_MAPBOX_ACCESS_TOKEN
npm install
npm run dev
```

- **Vector Tile Source**: Loads `http://localhost:3000/api/tiles/{z}/{x}/{y}.pbf` (`source-layer: municipal_parcels`) and renders parcel polygons with a `risk_score` color ramp.
- **Interactive Valuation**: Clicking any parcel extracts `parcel_id`, `circle_rate`, and `distance_to_hazard` (or `distance`), posts to `http://localhost:8000/predict/risk`, and renders `risk_score` and `risk_adjusted_valuation` in both the sidebar and a Mapbox GL popup.
