-- ============================================================================
-- GeoValue 2.0 — Saved Portfolios Schema (Supabase + Local PostgreSQL)
-- File: database/02_saved_portfolios.sql
-- Purpose: Persist user-bookmarked municipal parcels with Supabase Row Level
--          Security (RLS) and provide a local fallback table when running
--          against standalone PostGIS without Supabase Auth.
-- ============================================================================

-- 1. Supabase-authenticated portfolio table (with auth.users foreign key & RLS)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'auth' AND table_name = 'users'
    ) THEN
        CREATE TABLE IF NOT EXISTS public.saved_portfolios (
            id                      BIGSERIAL PRIMARY KEY,
            user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            parcel_id               VARCHAR(64) NOT NULL,
            circle_rate             NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
            risk_score              NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
            risk_adjusted_valuation NUMERIC(14, 2),
            distance_to_hazard      NUMERIC(10, 2),
            longitude               DOUBLE PRECISION,
            latitude                DOUBLE PRECISION,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            CONSTRAINT uq_saved_portfolios_user_parcel UNIQUE (user_id, parcel_id)
        );

        CREATE INDEX IF NOT EXISTS idx_saved_portfolios_user_id
            ON public.saved_portfolios (user_id);

        ALTER TABLE public.saved_portfolios ENABLE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS "Users can view their own saved parcels" ON public.saved_portfolios;
        CREATE POLICY "Users can view their own saved parcels"
            ON public.saved_portfolios
            FOR SELECT
            USING (auth.uid() = user_id);

        DROP POLICY IF EXISTS "Users can bookmark parcels to their own portfolio" ON public.saved_portfolios;
        CREATE POLICY "Users can bookmark parcels to their own portfolio"
            ON public.saved_portfolios
            FOR INSERT
            WITH CHECK (auth.uid() = user_id);

        DROP POLICY IF EXISTS "Users can update their own saved parcels" ON public.saved_portfolios;
        CREATE POLICY "Users can update their own saved parcels"
            ON public.saved_portfolios
            FOR UPDATE
            USING (auth.uid() = user_id)
            WITH CHECK (auth.uid() = user_id);

        DROP POLICY IF EXISTS "Users can delete their own saved parcels" ON public.saved_portfolios;
        CREATE POLICY "Users can delete their own saved parcels"
            ON public.saved_portfolios
            FOR DELETE
            USING (auth.uid() = user_id);
    END IF;
END
$$;

-- 2. Standalone PostgreSQL fallback table (used by Node.js API when Supabase auth schema is absent)
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

CREATE INDEX IF NOT EXISTS idx_saved_portfolios_local_user_id
    ON public.saved_portfolios_local (user_id);
