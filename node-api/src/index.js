require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = Number.parseInt(process.env.PORT, 10) || 3000;
const riskServiceUrl = process.env.RISK_SERVICE_URL || "http://localhost:8000";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

app.use(cors());
app.use(express.json());

const MAX_ZOOM = 22;
let localPortfolioTableReady = false;

/**
 * Ensure fallback local portfolio table exists when Supabase auth schema is absent.
 */
async function ensureLocalPortfolioTable() {
  if (localPortfolioTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.saved_portfolios_local (
      id                      BIGSERIAL PRIMARY KEY,
      user_id                 VARCHAR(128) NOT NULL,
      parcel_id               VARCHAR(64) NOT NULL,
      circle_rate             NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
      risk_score              NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
      risk_adjusted_valuation NUMERIC(14, 2),
      distance_to_hazard      NUMERIC(10, 2),
      longitude               DOUBLE PRECISION,
      latitude                DOUBLE PRECISION,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_saved_portfolios_local_user_parcel UNIQUE (user_id, parcel_id)
    );
  `);
  localPortfolioTableReady = true;
}

/**
 * Strictly parse a non-negative integer tile coordinate from a route parameter.
 * @param {string} raw
 * @returns {number}
 */
function parseTileCoord(raw) {
  if (!/^\d+$/.test(raw)) {
    return Number.NaN;
  }
  return Number.parseInt(raw, 10);
}

/**
 * Health check endpoint verifying API readiness and PostGIS connectivity.
 */
app.get("/health", async (_req, res) => {
  try {
    const result = await pool.query("SELECT PostGIS_Version() AS postgis_version;");
    return res.json({
      status: "ok",
      service: "geovalue-node-api",
      postgis: result.rows[0]?.postgis_version || "unknown",
    });
  } catch (err) {
    return res.status(503).json({
      status: "degraded",
      service: "geovalue-node-api",
      error: err.message,
    });
  }
});

/**
 * Serve dynamic Mapbox Vector Tiles (MVT) from municipal_parcels.
 *
 * Uses ST_TileEnvelope (EPSG:3857) transformed to SRID 4326 so the bounding-box
 * predicate leverages the GiST spatial index, then projects clipped parcel
 * geometries into Web Mercator tile coordinates.
 */
app.get(["/api/tiles/:z/:x/:y.mvt", "/api/tiles/:z/:x/:y.pbf"], async (req, res, next) => {
  const z = parseTileCoord(req.params.z);
  const x = parseTileCoord(req.params.x);
  const y = parseTileCoord(req.params.y);

  const maxIndex = 2 ** z;
  if (
    Number.isNaN(z) ||
    Number.isNaN(x) ||
    Number.isNaN(y) ||
    z < 0 ||
    z > MAX_ZOOM ||
    x < 0 ||
    x >= maxIndex ||
    y < 0 ||
    y >= maxIndex
  ) {
    return res.status(400).json({
      error: "Invalid tile coordinates. Expected integers with 0 <= z <= 22 and 0 <= x, y < 2^z.",
    });
  }

  const mvtQuery = `
    WITH env AS (
      SELECT ST_TileEnvelope($1::int, $2::int, $3::int) AS geom_3857
    ),
    bounds AS (
      SELECT
        geom_3857,
        ST_Transform(geom_3857, 4326) AS geom_4326
      FROM env
    ),
    mvtgeom AS (
      SELECT
        p.parcel_id,
        p.circle_rate::float8 AS circle_rate,
        p.risk_score::float8 AS risk_score,
        ST_AsMVTGeom(
          ST_Transform(p.geometry, 3857),
          bounds.geom_3857,
          4096,
          256,
          true
        ) AS geom
      FROM municipal_parcels AS p
      CROSS JOIN bounds
      WHERE p.geometry && bounds.geom_4326
        AND ST_Intersects(p.geometry, bounds.geom_4326)
    )
    SELECT ST_AsMVT(mvtgeom.*, 'municipal_parcels', 4096, 'geom') AS mvt
    FROM mvtgeom
    WHERE geom IS NOT NULL;
  `;

  try {
    const { rows } = await pool.query(mvtQuery, [z, x, y]);
    const tileBuffer = rows[0]?.mvt;

    if (!tileBuffer || tileBuffer.length === 0) {
      return res.status(204).end();
    }

    res.setHeader("Content-Type", "application/vnd.mapbox-vector-tile");
    return res.status(200).send(tileBuffer);
  } catch (err) {
    return next(err);
  }
});

/**
 * Fetch municipal parcels intersecting a WGS 84 bounding box as GeoJSON FeatureCollection.
 */
app.get("/api/parcels/bbox", async (req, res, next) => {
  const minLon = Number.parseFloat(req.query.minLon);
  const minLat = Number.parseFloat(req.query.minLat);
  const maxLon = Number.parseFloat(req.query.maxLon);
  const maxLat = Number.parseFloat(req.query.maxLat);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, requestedLimit))
    : 500;

  if (
    [minLon, minLat, maxLon, maxLat].some((val) => !Number.isFinite(val)) ||
    minLon >= maxLon ||
    minLat >= maxLat ||
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90
  ) {
    return res.status(400).json({
      error: "Valid minLon, minLat, maxLon, maxLat bounding box coordinates are required.",
    });
  }

  const bboxQuery = `
    WITH env AS (
      SELECT ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326) AS bbox
    )
    SELECT
      p.parcel_id,
      p.circle_rate::float8 AS circle_rate,
      p.risk_score::float8 AS risk_score,
      ST_AsGeoJSON(p.geometry)::json AS geometry
    FROM municipal_parcels AS p
    CROSS JOIN env
    WHERE p.geometry && env.bbox
      AND ST_Intersects(p.geometry, env.bbox)
    LIMIT $5;
  `;

  try {
    const { rows } = await pool.query(bboxQuery, [minLon, minLat, maxLon, maxLat, limit]);
    const features = rows.map((row) => ({
      type: "Feature",
      properties: {
        parcel_id: row.parcel_id,
        circle_rate: row.circle_rate,
        risk_score: row.risk_score,
      },
      geometry: row.geometry,
    }));

    return res.json({
      type: "FeatureCollection",
      features,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Fetch parcel valuation & climate risk by WGS 84 (SRID 4326) coordinate.
 */
app.get("/v1/parcels/lookup", async (req, res, next) => {
  const lon = Number.parseFloat(req.query.lon);
  const lat = Number.parseFloat(req.query.lat);

  if (Number.isNaN(lon) || Number.isNaN(lat)) {
    return res.status(400).json({
      error: "Valid 'lon' and 'lat' query parameters are required.",
    });
  }

  try {
    const query = `
      SELECT
        parcel_id,
        circle_rate,
        risk_score,
        ST_AsGeoJSON(geometry)::json AS geometry
      FROM municipal_parcels
      WHERE ST_Intersects(geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326))
      LIMIT 1;
    `;
    const { rows } = await pool.query(query, [lon, lat]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "No municipal parcel found at coordinates." });
    }
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

/**
 * Local portfolio fallback endpoints (used when Supabase cloud credentials are unset).
 */
app.get("/api/portfolios", async (req, res, next) => {
  const userId = String(req.query.user_id || "").trim();
  if (!userId) {
    return res.status(400).json({ error: "Query parameter 'user_id' is required." });
  }

  try {
    await ensureLocalPortfolioTable();
    const { rows } = await pool.query(
      `SELECT
         id,
         user_id,
         parcel_id,
         circle_rate::float8 AS circle_rate,
         risk_score::float8 AS risk_score,
         risk_adjusted_valuation::float8 AS risk_adjusted_valuation,
         distance_to_hazard::float8 AS distance_to_hazard,
         longitude,
         latitude,
         created_at
       FROM public.saved_portfolios_local
       WHERE user_id = $1
       ORDER BY created_at DESC;`,
      [userId]
    );
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

app.post("/api/portfolios", async (req, res, next) => {
  const {
    user_id: userId,
    parcel_id: parcelId,
    circle_rate: circleRate = 0,
    risk_score: riskScore = 0,
    risk_adjusted_valuation: riskAdjustedValuation = null,
    distance_to_hazard: distanceToHazard = null,
    longitude = null,
    latitude = null,
  } = req.body || {};

  if (!userId || !parcelId) {
    return res.status(400).json({ error: "'user_id' and 'parcel_id' are required." });
  }

  try {
    await ensureLocalPortfolioTable();
    const { rows } = await pool.query(
      `INSERT INTO public.saved_portfolios_local (
         user_id,
         parcel_id,
         circle_rate,
         risk_score,
         risk_adjusted_valuation,
         distance_to_hazard,
         longitude,
         latitude
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, parcel_id)
       DO UPDATE SET
         circle_rate = EXCLUDED.circle_rate,
         risk_score = EXCLUDED.risk_score,
         risk_adjusted_valuation = EXCLUDED.risk_adjusted_valuation,
         distance_to_hazard = EXCLUDED.distance_to_hazard,
         longitude = COALESCE(EXCLUDED.longitude, public.saved_portfolios_local.longitude),
         latitude = COALESCE(EXCLUDED.latitude, public.saved_portfolios_local.latitude)
       RETURNING
         id,
         user_id,
         parcel_id,
         circle_rate::float8 AS circle_rate,
         risk_score::float8 AS risk_score,
         risk_adjusted_valuation::float8 AS risk_adjusted_valuation,
         distance_to_hazard::float8 AS distance_to_hazard,
         longitude,
         latitude,
         created_at;`,
      [
        String(userId),
        String(parcelId),
        Number(circleRate) || 0,
        Number(riskScore) || 0,
        riskAdjustedValuation !== null ? Number(riskAdjustedValuation) : null,
        distanceToHazard !== null ? Number(distanceToHazard) : null,
        longitude !== null ? Number(longitude) : null,
        latitude !== null ? Number(latitude) : null,
      ]
    );
    return res.status(201).json({ item: rows[0] });
  } catch (err) {
    return next(err);
  }
});

app.delete("/api/portfolios/:parcelId", async (req, res, next) => {
  const userId = String(req.query.user_id || "").trim();
  const parcelId = String(req.params.parcelId || "").trim();

  if (!userId || !parcelId) {
    return res.status(400).json({ error: "'user_id' query param and 'parcelId' are required." });
  }

  try {
    await ensureLocalPortfolioTable();
    const { rowCount } = await pool.query(
      `DELETE FROM public.saved_portfolios_local
       WHERE user_id = $1 AND parcel_id = $2;`,
      [userId, parcelId]
    );
    return res.json({ deleted: rowCount > 0, parcel_id: parcelId });
  } catch (err) {
    return next(err);
  }
});

/**
 * Proxy AI Valuation Chat queries to the Python FastAPI ML service.
 */
app.post("/api/chat/valuation", async (req, res, next) => {
  const { message, parcel_context: parcelContext = null, history = [] } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Non-empty 'message' field is required." });
  }

  try {
    const upstreamResponse = await fetch(`${riskServiceUrl}/chat/valuation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message.trim(),
        parcel_context: parcelContext,
        history,
      }),
    });

    const data = await upstreamResponse.json().catch(() => ({}));
    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: data.detail || "Upstream risk chat service error.",
      });
    }

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

/**
 * 404 handler for unmatched routes.
 */
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found." });
});

/**
 * Global Express error handler.
 */
app.use((err, _req, res, _next) => {
  console.error("Unhandled API error:", err);
  res.status(err.status || 500).json({
    error: "Internal server error.",
    message: process.env.NODE_ENV === "production" ? undefined : err.message,
  });
});

const server = app.listen(port, () => {
  console.log(`GeoValue 2.0 Node API listening on port ${port}`);
});

/**
 * Gracefully close HTTP server and PostgreSQL connection pool on termination.
 */
function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down GeoValue 2.0 Node API...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log("PostgreSQL pool closed.");
      process.exit(0);
    } catch (err) {
      console.error("Error closing PostgreSQL pool:", err);
      process.exit(1);
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
