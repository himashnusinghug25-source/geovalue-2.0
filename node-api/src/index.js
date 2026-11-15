require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = Number.parseInt(process.env.PORT, 10) || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

app.use(cors());
app.use(express.json());

const MAX_ZOOM = 22;

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
 * predicate leverages the GiST spatial index (idx_municipal_parcels_geom),
 * then projects clipped parcel geometries into Web Mercator tile coordinates.
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
