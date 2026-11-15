-- ============================================================================
-- GeoValue 2.0 — Spatial Database Schema
-- File: database/01_municipal_parcels.sql
-- Purpose: Provision PostGIS extension, municipal_parcels table, spatial
--          validity constraints, and GiST spatial index for real-time
--          climate risk and property valuation queries.
-- ============================================================================

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
