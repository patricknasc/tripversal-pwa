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

-- ─── Expenses ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id                 TEXT        PRIMARY KEY,  -- Date.now().toString() from client
  trip_id            UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  description        TEXT        NOT NULL,
  category           TEXT        NOT NULL,
  date               TIMESTAMPTZ NOT NULL,
  source_id          TEXT        NOT NULL,
  type               TEXT        NOT NULL DEFAULT 'personal',
  local_amount       NUMERIC     NOT NULL,
  local_currency     TEXT        NOT NULL,
  base_amount        NUMERIC     NOT NULL,
  base_currency      TEXT        NOT NULL,
  local_to_base_rate NUMERIC     NOT NULL DEFAULT 1,
  who_paid           TEXT,
  splits             JSONB,
  city               TEXT,
  edit_history       JSONB,
  receipt_data       TEXT,          -- base64 compressed image (optional)
  deleted_at         TIMESTAMPTZ,   -- NULL = active; set = soft-deleted
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS expenses_trip_active ON expenses(trip_id) WHERE deleted_at IS NULL;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_expenses" ON expenses FOR ALL USING (true);

-- ─── User Medical IDs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_medical_ids (
  google_sub      TEXT        PRIMARY KEY,
  blood_type      TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  allergies       TEXT,
  medications     TEXT,
  notes           TEXT,
  sharing         BOOLEAN     DEFAULT TRUE,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_medical_ids ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_medical" ON user_medical_ids FOR ALL USING (true);

-- ─── User Insurance ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_insurance (
  google_sub      TEXT        PRIMARY KEY,
  provider        TEXT,
  policy_number   TEXT,
  emergency_phone TEXT,
  coverage_start  DATE,
  coverage_end    DATE,
  notes           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_insurance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_insurance" ON user_insurance FOR ALL USING (true);

-- ─── User Documents ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_documents (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  google_sub  TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  doc_type    TEXT        NOT NULL,
  file_data   TEXT        NOT NULL,  -- base64 compressed image
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_documents_sub ON user_documents(google_sub);
ALTER TABLE user_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_user_docs" ON user_documents FOR ALL USING (true);

-- ─── Segment Attachments ─────────────────────────────────────────────────────
-- Critical itinerary files: boarding passes, tickets, hotel confirmations, etc.
CREATE TABLE IF NOT EXISTS segment_attachments (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  segment_id  UUID        NOT NULL REFERENCES trip_segments(id) ON DELETE CASCADE,
  trip_id     UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  file_data   TEXT        NOT NULL,  -- base64 compressed image
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS segment_attachments_seg ON segment_attachments(segment_id);
ALTER TABLE segment_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_seg_att" ON segment_attachments FOR ALL USING (true);
