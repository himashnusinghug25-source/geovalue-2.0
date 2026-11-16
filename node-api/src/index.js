require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = Number.parseInt(process.env.PORT, 10) || 3000;
const riskServiceUrl = process.env.RISK_SERVICE_URL || "http://localhost:8000";

const rawDbUrl = process.env.DATABASE_URL || "";
const isSupabaseDb = /supabase\.(co|com)/i.test(rawDbUrl);
const sanitizedDbUrl = isSupabaseDb
  ? rawDbUrl.replace(/([?&])sslmode=[^&]+(&?)/i, (_m, p1, p2) => (p2 ? p1 : ""))
  : rawDbUrl;

const pool = new Pool({
  connectionString: sanitizedDbUrl,
  connectionTimeoutMillis: 3500,
  idleTimeoutMillis: 10000,
  query_timeout: 3500,
  max: 10,
  ssl: isSupabaseDb ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

app.use(cors());
app.use(express.json());

const MAX_ZOOM = 22;
const DB_BACKOFF_MS = 15000;
let dbBackoffUntil = 0;
let localPortfolioTableReady = false;

// Broad Delhi NCR geographic envelope (Gurgaon, Delhi, Faridabad, Noida, Ghaziabad)
const NCR_BOUNDS = {
  minLon: 76.8,
  maxLon: 77.6,
  minLat: 28.35,
  maxLat: 28.9,
};

const NCR_ZONE_TYPES = [
  "Commercial Mixed-Use",
  "High-Density Residential",
  "IT / SEZ Institutional",
  "Transit-Oriented Corridor",
];

const NCR_SOIL_CLASSES = [
  "Yamuna Khadar Alluvial Silt",
  "Indo-Gangetic Sandy Loam",
  "Aravalli Quartzitic Gravel",
  "Alluvial Clay-Loam Terrace",
];

/**
 * Deterministic hash returning [0, 1) from an arbitrary seed string.
 */
function deterministicUnit(seed) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * Compute approximate Haversine distance in meters between two WGS84 points.
 */
function haversineMeters(lon1, lat1, lon2, lat2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Resolve Delhi NCR administrative sub-region profile & primary hydrological corridor.
 */
function resolveNcrProfile(lon, lat) {
  if (lon >= 77.31 && lon <= 77.41 && lat >= 28.48 && lat <= 28.56) {
    return {
      prefix: "NOIDA-S128",
      subRegion: "Noida Sector 128",
      baseRate: 145000,
      hazardLon: 77.333,
      hazardLat: 28.504,
      baseElev: 201.5,
    };
  }
  if (lon >= 77.3 && lat < 28.61) {
    return {
      prefix: "NOIDA-EXP",
      subRegion: "Noida Expressway",
      baseRate: 125000,
      hazardLon: 77.338,
      hazardLat: 28.516,
      baseElev: 204.0,
    };
  }
  if (lon >= 77.36 && lat >= 28.61) {
    return {
      prefix: "GZB-IND",
      subRegion: "Ghaziabad Indirapuram",
      baseRate: 88000,
      hazardLon: 77.406,
      hazardLat: 28.655,
      baseElev: 211.0,
    };
  }
  if (lon <= 77.15 && lat <= 28.55) {
    return {
      prefix: "GGN-CYB",
      subRegion: "Gurugram Cyber City",
      baseRate: 245000,
      hazardLon: 77.082,
      hazardLat: 28.474,
      baseElev: 229.0,
    };
  }
  if (lat < 28.47 && lon >= 77.22 && lon <= 77.4) {
    return {
      prefix: "FBD-SEC",
      subRegion: "Faridabad Central",
      baseRate: 76000,
      hazardLon: 77.352,
      hazardLat: 28.423,
      baseElev: 205.5,
    };
  }
  return {
    prefix: "DLH-NCR",
    subRegion: "New Delhi Central",
    baseRate: 340000,
    hazardLon: 77.253,
    hazardLat: 28.631,
    baseElev: 216.0,
  };
}

/**
 * Enrich an existing PostGIS parcel feature with full Indian GIS metadata if absent.
 */
function enrichParcelProperties(rawProps, centroidLon, centroidLat, sourceOrigin) {
  const lon = Number.isFinite(centroidLon) ? centroidLon : 77.3513;
  const lat = Number.isFinite(centroidLat) ? centroidLat : 28.5112;
  const profile = resolveNcrProfile(lon, lat);
  const seed = `${rawProps.parcel_id || ""}:${lon.toFixed(4)}:${lat.toFixed(4)}`;
  const u1 = deterministicUnit(`${seed}:z`);
  const u2 = deterministicUnit(`${seed}:s`);
  const u3 = deterministicUnit(`${seed}:e`);
  const u4 = deterministicUnit(`${seed}:area`);
  const u5 = deterministicUnit(`${seed}:infra`);
  const u6 = deterministicUnit(`${seed}:safety`);

  const hazardDist =
    rawProps.distance_to_hazard ??
    rawProps.hazard_distance_m ??
    Math.max(
      45,
      Math.min(
        1850,
        Math.round(haversineMeters(lon, lat, profile.hazardLon, profile.hazardLat) * 0.42)
      )
    );

  // Calibrate circle rate in ₹/Gaj (45,000 - 4,50,000 ₹/Gaj)
  let circleRate = Number(rawProps.circle_rate ?? profile.baseRate);
  if (!Number.isFinite(circleRate) || circleRate <= 0) {
    circleRate = profile.baseRate;
  } else if (circleRate < 15000) {
    circleRate = Math.round(profile.baseRate * (0.82 + u1 * 0.36));
  }

  return {
    parcel_id: String(rawProps.parcel_id),
    circle_rate: Math.round(circleRate),
    risk_score: Number(rawProps.risk_score ?? 35),
    distance_to_hazard: Number(hazardDist),
    hazard_distance_m: Number(hazardDist),
    plot_area_gaj: Number((160 + u4 * 290).toFixed(0)),
    metro_distance_m: Math.round(350 + u5 * 2100),
    highway_distance_m: Math.round(240 + u1 * 1850),
    hospital_distance_m: Math.round(520 + u2 * 2400),
    mall_distance_m: Math.round(640 + u3 * 2800),
    police_distance_m: Math.round(420 + u6 * 1700),
    safety_score: Number((58 + u6 * 34).toFixed(1)),
    zone_type:
      rawProps.zone_type ||
      NCR_ZONE_TYPES[Math.floor(u1 * NCR_ZONE_TYPES.length)],
    soil_class:
      rawProps.soil_class ||
      NCR_SOIL_CLASSES[Math.floor(u2 * NCR_SOIL_CLASSES.length)],
    elevation_m: Number(
      rawProps.elevation_m ?? (profile.baseElev + (u3 - 0.5) * 9.5).toFixed(1)
    ),
    sub_region: rawProps.sub_region || profile.subRegion,
    centroid_lon: Number(lon.toFixed(6)),
    centroid_lat: Number(lat.toFixed(6)),
    source_origin: sourceOrigin,
  };
}

/**
 * Check whether a bounding box overlaps the Delhi NCR region.
 */
function intersectsNcr(minLon, minLat, maxLon, maxLat) {
  return (
    maxLon >= NCR_BOUNDS.minLon &&
    minLon <= NCR_BOUNDS.maxLon &&
    maxLat >= NCR_BOUNDS.minLat &&
    minLat <= NCR_BOUNDS.maxLat
  );
}

/**
 * Deterministically synthesize realistic NCR municipal parcels inside the active
 * viewport when PostGIS has fewer than 15 parcels for that bounding box.
 */
function synthesizeNcrParcelsForBbox(
  minLon,
  minLat,
  maxLon,
  maxLat,
  existingFeatures = [],
  targetCount = 18
) {
  if (!intersectsNcr(minLon, minLat, maxLon, maxLat)) {
    return existingFeatures;
  }

  const needed = Math.max(0, targetCount - existingFeatures.length);
  if (needed === 0) return existingFeatures;

  const clampedMinLon = Math.max(minLon, NCR_BOUNDS.minLon);
  const clampedMaxLon = Math.min(maxLon, NCR_BOUNDS.maxLon);
  const clampedMinLat = Math.max(minLat, NCR_BOUNDS.minLat);
  const clampedMaxLat = Math.min(maxLat, NCR_BOUNDS.maxLat);

  const centerLon = (clampedMinLon + clampedMaxLon) / 2;
  const centerLat = (clampedMinLat + clampedMaxLat) / 2;
  const spanLon = Math.max(0.008, Math.min(0.08, (clampedMaxLon - clampedMinLon) * 0.72));
  const spanLat = Math.max(0.008, Math.min(0.08, (clampedMaxLat - clampedMinLat) * 0.72));

  // Snap anchor to a stable spatial grid so panning gently keeps consistent parcel IDs
  const gridStep = Math.max(0.0035, Math.min(0.015, spanLon / 4.5));
  const startLon = Math.floor((centerLon - spanLon / 2) / gridStep) * gridStep;
  const startLat = Math.floor((centerLat - spanLat / 2) / gridStep) * gridStep;

  const synthesized = [];
  const cols = 5;
  const rows = 4;

  for (let r = 0; r < rows && synthesized.length < needed; r += 1) {
    for (let c = 0; c < cols && synthesized.length < needed; c += 1) {
      const baseLon = startLon + (c + 0.5) * gridStep;
      const baseLat = startLat + (r + 0.5) * gridStep;

      const cellKey = `${Math.round(baseLon / gridStep)}:${Math.round(baseLat / gridStep)}`;
      const jitterLon = (deterministicUnit(`${cellKey}:dx`) - 0.5) * gridStep * 0.42;
      const jitterLat = (deterministicUnit(`${cellKey}:dy`) - 0.5) * gridStep * 0.42;

      const pLon = Number((baseLon + jitterLon).toFixed(6));
      const pLat = Number((baseLat + jitterLat).toFixed(6));

      if (
        pLon < clampedMinLon ||
        pLon > clampedMaxLon ||
        pLat < clampedMinLat ||
        pLat > clampedMaxLat
      ) {
        continue;
      }

      // Skip if very close to an existing DB parcel centroid
      const tooClose = existingFeatures.some((feat) => {
        const cLon = feat.properties?.centroid_lon;
        const cLat = feat.properties?.centroid_lat;
        if (!Number.isFinite(cLon) || !Number.isFinite(cLat)) return false;
        return Math.abs(cLon - pLon) < 0.0011 && Math.abs(cLat - pLat) < 0.0011;
      });
      if (tooClose) continue;

      const profile = resolveNcrProfile(pLon, pLat);
      const uRate = deterministicUnit(`${cellKey}:rate`);
      const uSize = deterministicUnit(`${cellKey}:size`);

      const parcelId = `${profile.prefix}-${String(
        Math.abs(Math.round(pLat * 10000)) % 900 + 100
      )}-${String(Math.abs(Math.round(pLon * 10000)) % 90 + 10)}`;

      const rawDist = haversineMeters(pLon, pLat, profile.hazardLon, profile.hazardLat);
      const hazardDistanceM = Math.max(
        40,
        Math.min(1800, Math.round(rawDist * (0.28 + uSize * 0.35)))
      );

      const circleRate = Math.round(
        profile.baseRate * (0.72 + uRate * 0.65)
      );

      // Compute aligned risk score matching FastAPI spatial decay curve
      const decay = Math.exp(-hazardDistanceM / 500);
      const leaf =
        hazardDistanceM <= 50
          ? 22
          : hazardDistanceM <= 150
          ? 14.5
          : hazardDistanceM <= 500
          ? 8
          : hazardDistanceM <= 1500
          ? 3.5
          : 0.5;
      const interaction = Math.min(8, Math.log1p(circleRate) * 0.45 * decay);
      const riskScore = Number(
        Math.max(5, Math.min(98, 70 * decay + leaf + interaction)).toFixed(2)
      );

      const halfW = 0.00055 + uSize * 0.00045;
      const halfH = 0.00045 + uRate * 0.00035;

      const properties = enrichParcelProperties(
        {
          parcel_id: parcelId,
          circle_rate: circleRate,
          risk_score: riskScore,
          distance_to_hazard: hazardDistanceM,
        },
        pLon,
        pLat,
        "synthesized_ncr"
      );

      synthesized.push({
        type: "Feature",
        properties,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [Number((pLon - halfW).toFixed(6)), Number((pLat - halfH).toFixed(6))],
              [Number((pLon + halfW).toFixed(6)), Number((pLat - halfH).toFixed(6))],
              [Number((pLon + halfW).toFixed(6)), Number((pLat + halfH).toFixed(6))],
              [Number((pLon - halfW).toFixed(6)), Number((pLat + halfH).toFixed(6))],
              [Number((pLon - halfW).toFixed(6)), Number((pLat - halfH).toFixed(6))],
            ],
          ],
        },
      });
    }
  }

  return [...existingFeatures, ...synthesized];
}

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
app.get(
  [
    "/tiles/:z/:x/:y.mvt",
    "/tiles/:z/:x/:y.pbf",
    "/api/tiles/:z/:x/:y.mvt",
    "/api/tiles/:z/:x/:y.pbf",
  ],
  async (req, res, next) => {
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

    if (Date.now() < dbBackoffUntil) {
      return res.status(204).end();
    }

    try {
      const { rows } = await pool.query(mvtQuery, [z, x, y]);
      const tileBuffer = rows[0]?.mvt;

      if (!tileBuffer || tileBuffer.length === 0) {
        return res.status(204).end();
      }

      res.setHeader("Content-Type", "application/vnd.mapbox-vector-tile");
      return res.status(200).send(tileBuffer);
    } catch (err) {
      dbBackoffUntil = Date.now() + DB_BACKOFF_MS;
      console.warn(`MVT tile (${z}/${x}/${y}) fallback 204 due to PostGIS timeout/error:`, err.message);
      return res.status(204).end();
    }
  }
);

/**
 * Fetch municipal parcels intersecting a WGS 84 bounding box as GeoJSON FeatureCollection.
 * If an NCR bounding box contains fewer than 15 PostGIS parcels, deterministically
 * synthesizes realistic municipal parcels around the viewport center for pan-NCR coverage.
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
      ST_X(ST_Centroid(p.geometry))::float8 AS centroid_lon,
      ST_Y(ST_Centroid(p.geometry))::float8 AS centroid_lat,
      ST_AsGeoJSON(p.geometry)::json AS geometry
    FROM municipal_parcels AS p
    CROSS JOIN env
    WHERE p.geometry && env.bbox
      AND ST_Intersects(p.geometry, env.bbox)
    LIMIT $5;
  `;

  let dbFeatures = [];
  if (Date.now() >= dbBackoffUntil) {
    try {
      const { rows } = await pool.query(bboxQuery, [minLon, minLat, maxLon, maxLat, limit]);
      dbFeatures = rows.map((row) => ({
        type: "Feature",
        properties: enrichParcelProperties(
          row,
          row.centroid_lon,
          row.centroid_lat,
          "postgis"
        ),
        geometry: row.geometry,
      }));
    } catch (err) {
      dbBackoffUntil = Date.now() + DB_BACKOFF_MS;
      // If PostGIS is unreachable while querying NCR, still return deterministic NCR parcels
      if (!intersectsNcr(minLon, minLat, maxLon, maxLat)) {
        return next(err);
      }
      console.warn("PostGIS bbox query unavailable; serving synthesized NCR parcels:", err.message);
    }
  }

  const features =
    dbFeatures.length < 15
      ? synthesizeNcrParcelsForBbox(minLon, minLat, maxLon, maxLat, dbFeatures, 18)
      : dbFeatures;

  return res.json({
    type: "FeatureCollection",
    features,
  });
});

/**
 * Serve the 5 toggleable Delhi-NCR Spatial Map Layers (GeoJSON FeatureCollections):
 *   1. metro_rrts        — DMRC Metro corridors, Aqua Line & RapidX RRTS stations
 *   2. roads_expressways — NH-48, Noida Expy, Dwarka Expy, UER-II, FNG with RoW widths
 *   3. social_infra      — Multispecialty Hospitals, Grade-A Malls & University clusters
 *   4. flood_hazard      — Yamuna 100-yr floodplain, Hindon basin & Najafgarh drain buffer
 *   5. crime_safety      — NCR ward safety index & police station proximity nodes
 */
app.get("/api/layers/ncr-overlays", (_req, res) => {
  const metro_rrts = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "DMRC Magenta Line (Janakpuri–Botanical Garden)", layer_kind: "line", corridor: "Magenta Line" },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.155, 28.545],
            [77.206, 28.544],
            [77.258, 28.548],
            [77.313, 28.556],
            [77.334, 28.564],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Noida Aqua Line & Sector 128–142 Corridor", layer_kind: "line", corridor: "Aqua Line" },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.362, 28.574],
            [77.381, 28.543],
            [77.392, 28.516],
            [77.412, 28.497],
            [77.468, 28.474],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Delhi–Meerut RapidX (Namo Bharat RRTS)", layer_kind: "line", corridor: "RapidX RRTS" },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.258, 28.589],
            [77.304, 28.636],
            [77.362, 28.674],
            [77.436, 28.698],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Gurugram Millennium City–Cyber City Metro Loop", layer_kind: "line", corridor: "Gurugram Metro" },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.072, 28.459],
            [77.088, 28.494],
            [77.041, 28.468],
            [77.024, 28.438],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Okhla Bird Sanctuary / Sec 126 Metro", layer_kind: "station", corridor: "Magenta Line", buffer_m: 800 },
        geometry: { type: "Point", coordinates: [77.316, 28.555] },
      },
      {
        type: "Feature",
        properties: { name: "Noida Sec 137 / Sec 128 Feeder Station", layer_kind: "station", corridor: "Aqua Line", buffer_m: 1000 },
        geometry: { type: "Point", coordinates: [77.389, 28.514] },
      },
      {
        type: "Feature",
        properties: { name: "Rajiv Chowk Interchange (Blue/Yellow)", layer_kind: "station", corridor: "DMRC Core", buffer_m: 500 },
        geometry: { type: "Point", coordinates: [77.219, 28.632] },
      },
      {
        type: "Feature",
        properties: { name: "CyberHub / Moulsari Ave Rapid Metro", layer_kind: "station", corridor: "Rapid Metro", buffer_m: 500 },
        geometry: { type: "Point", coordinates: [77.089, 28.495] },
      },
      {
        type: "Feature",
        properties: { name: "Sahibabad RapidX RRTS Station", layer_kind: "station", corridor: "RapidX RRTS", buffer_m: 1000 },
        geometry: { type: "Point", coordinates: [77.362, 28.674] },
      },
      {
        type: "Feature",
        properties: { name: "Bata Chowk / Escorts Mujesar Metro", layer_kind: "station", corridor: "Violet Line", buffer_m: 800 },
        geometry: { type: "Point", coordinates: [77.313, 28.385] },
      },
    ],
  };

  const roads_expressways = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Noida–Greater Noida Expressway", row_width_m: 75 },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.312, 28.552],
            [77.345, 28.516],
            [77.372, 28.494],
            [77.428, 28.468],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "NH-48 Delhi–Gurugram Expressway", row_width_m: 90 },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.148, 28.568],
            [77.094, 28.504],
            [77.064, 28.465],
            [77.008, 28.414],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Dwarka Expressway (NH-248BB / UER-II)", row_width_m: 150 },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.058, 28.552],
            [77.018, 28.508],
            [76.978, 28.468],
            [76.968, 28.418],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "DND Flyway & Outer Ring Road", row_width_m: 60 },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.262, 28.575],
            [77.302, 28.572],
            [77.234, 28.545],
            [77.175, 28.548],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "NH-9 Delhi–Ghaziabad Elevated Corridor", row_width_m: 90 },
        geometry: {
          type: "LineString",
          coordinates: [
            [77.285, 28.622],
            [77.358, 28.636],
            [77.435, 28.652],
          ],
        },
      },
    ],
  };

  const social_infra = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Max / Jaypee Super Speciality Hospital, Sec 128", category: "Hospital" },
        geometry: { type: "Point", coordinates: [77.365, 28.514] },
      },
      {
        type: "Feature",
        properties: { name: "DLF Mall of India, Noida Sec 18", category: "Mall" },
        geometry: { type: "Point", coordinates: [77.321, 28.567] },
      },
      {
        type: "Feature",
        properties: { name: "Amity University Campus, Sec 125", category: "Education" },
        geometry: { type: "Point", coordinates: [77.333, 28.544] },
      },
      {
        type: "Feature",
        properties: { name: "AIIMS New Delhi & Safdarjung Medical Hub", category: "Hospital" },
        geometry: { type: "Point", coordinates: [77.21, 28.567] },
      },
      {
        type: "Feature",
        properties: { name: "Select Citywalk & DLF Avenue, Saket", category: "Mall" },
        geometry: { type: "Point", coordinates: [77.219, 28.529] },
      },
      {
        type: "Feature",
        properties: { name: "Medanta — The Medicity, Gurugram", category: "Hospital" },
        geometry: { type: "Point", coordinates: [77.041, 28.439] },
      },
      {
        type: "Feature",
        properties: { name: "DLF CyberHub & Ambience Mall", category: "Mall" },
        geometry: { type: "Point", coordinates: [77.089, 28.495] },
      },
      {
        type: "Feature",
        properties: { name: "Yashoda Super Speciality Hospital, Kaushambi/GZB", category: "Hospital" },
        geometry: { type: "Point", coordinates: [77.327, 28.645] },
      },
      {
        type: "Feature",
        properties: { name: "Asian Institute of Medical Sciences, Faridabad", category: "Hospital" },
        geometry: { type: "Point", coordinates: [77.311, 28.414] },
      },
    ],
  };

  const flood_hazard = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Yamuna River 100-Yr Floodplain (NGT Zone-O)", hazard_level: "Critical", return_period: "100-Year" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [77.245, 28.68],
              [77.285, 28.68],
              [77.325, 28.56],
              [77.342, 28.48],
              [77.365, 28.39],
              [77.34, 28.39],
              [77.315, 28.48],
              [77.295, 28.56],
              [77.245, 28.68],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Hindon River Floodplain & Monsoon Buffer", hazard_level: "High", return_period: "50-Year" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [77.392, 28.705],
              [77.418, 28.705],
              [77.432, 28.615],
              [77.405, 28.615],
              [77.392, 28.705],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Najafgarh & Badshahpur Drain Waterlogging Zone", hazard_level: "Moderate-High", return_period: "25-Year" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [76.96, 28.52],
              [77.085, 28.488],
              [77.092, 28.468],
              [76.968, 28.498],
              [76.96, 28.52],
            ],
          ],
        },
      },
    ],
  };

  const crime_safety = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { ward_name: "Noida Sec 126–128 Express Zone", safety_score: 79, police_station: "PS Sector 126 Noida" },
        geometry: { type: "Point", coordinates: [77.352, 28.512] },
      },
      {
        type: "Feature",
        properties: { ward_name: "Lutyens / Connaught Place Core", safety_score: 91, police_station: "PS Connaught Place" },
        geometry: { type: "Point", coordinates: [77.218, 28.628] },
      },
      {
        type: "Feature",
        properties: { ward_name: "Hauz Khas / Saket South Delhi", safety_score: 84, police_station: "PS Hauz Khas" },
        geometry: { type: "Point", coordinates: [77.206, 28.545] },
      },
      {
        type: "Feature",
        properties: { ward_name: "DLF Cyber City / Golf Course Rd", safety_score: 86, police_station: "PS DLF Phase-II" },
        geometry: { type: "Point", coordinates: [77.088, 28.491] },
      },
      {
        type: "Feature",
        properties: { ward_name: "Indirapuram / Vaishali Corridor", safety_score: 74, police_station: "PS Indirapuram" },
        geometry: { type: "Point", coordinates: [77.372, 28.645] },
      },
      {
        type: "Feature",
        properties: { ward_name: "Faridabad Sector 15–21 Smart Hub", safety_score: 76, police_station: "PS Central Faridabad" },
        geometry: { type: "Point", coordinates: [77.318, 28.409] },
      },
    ],
  };

  return res.json({
    metro_rrts,
    roads_expressways,
    social_infra,
    flood_hazard,
    crime_safety,
  });
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
