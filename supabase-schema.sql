-- Tripversal PWA — Supabase schema
-- Run once in: Supabase Dashboard > SQL Editor > New Query

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Trips ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  destination  TEXT,
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  budget       JSONB NOT NULL DEFAULT '{"baseCurrency":"EUR","dailyLimit":400,"sources":[]}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Trip Members ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      UUID REFERENCES trips(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  name         TEXT,
  avatar_url   TEXT,
  google_sub   TEXT,
  role         TEXT NOT NULL DEFAULT 'member',
  status       TEXT NOT NULL DEFAULT 'pending',
  invited_at   TIMESTAMPTZ DEFAULT NOW(),
  accepted_at  TIMESTAMPTZ,
  UNIQUE(trip_id, email)
);

-- ─── Trip Segments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_segments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              UUID REFERENCES trips(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  start_date           DATE,
  end_date             DATE,
  origin               TEXT,
  destination          TEXT,
  color                TEXT DEFAULT '#00e5ff',
  assigned_member_ids  UUID[] DEFAULT '{}',
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Invite Tokens ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invite_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID REFERENCES trips(id) ON DELETE CASCADE,
  member_id   UUID REFERENCES trip_members(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  token       TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  used_at     TIMESTAMPTZ
);

-- ─── Row Level Security (service role bypasses all) ───────────────────────
ALTER TABLE trips         ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_tokens ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (needed for API routes)
CREATE POLICY "service_role_all_trips"    ON trips         FOR ALL USING (true);
CREATE POLICY "service_role_all_members"  ON trip_members  FOR ALL USING (true);
CREATE POLICY "service_role_all_segments" ON trip_segments FOR ALL USING (true);
CREATE POLICY "service_role_all_invites"  ON invite_tokens FOR ALL USING (true);
