-- CORE Postgres schema
-- Requires pgvector extension for embedding similarity.

CREATE EXTENSION IF NOT EXISTS vector;

-- Common updated_at trigger
CREATE OR REPLACE FUNCTION core_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Memories
-- =====================================================================

CREATE TABLE IF NOT EXISTS memories (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  subject_id            TEXT NOT NULL,
  text                  TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'fact',
  visibility            TEXT NOT NULL DEFAULT 'private',
  importance            INTEGER NOT NULL DEFAULT 50 CHECK (importance BETWEEN 0 AND 100),
  confidence            DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  is_temporal           BOOLEAN NOT NULL DEFAULT FALSE,
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding             VECTOR(1536),
  status                TEXT NOT NULL DEFAULT 'active',
  superseded_by         TEXT,
  is_deleted            BOOLEAN NOT NULL DEFAULT FALSE,
  source_type           TEXT NOT NULL DEFAULT 'explicit',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ,
  seen_count            INTEGER NOT NULL DEFAULT 0,
  reinforcement_count   INTEGER NOT NULL DEFAULT 0,
  last_reinforced_at    TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_kind_check'
  ) THEN
    ALTER TABLE memories
    ADD CONSTRAINT memories_kind_check
    CHECK (kind IN ('fact', 'preference', 'context', 'note', 'event', 'trait'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_visibility_check'
  ) THEN
    ALTER TABLE memories
    ADD CONSTRAINT memories_visibility_check
    CHECK (visibility IN ('private', 'shared', 'public'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_status_check'
  ) THEN
    ALTER TABLE memories
    ADD CONSTRAINT memories_status_check
    CHECK (status IN ('active', 'superseded'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_project_subject
  ON memories(project_id, subject_id);

CREATE INDEX IF NOT EXISTS idx_memories_project_subject_active
  ON memories(project_id, subject_id, status, is_deleted, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_superseded
  ON memories(project_id, subject_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_text_trgm
  ON memories USING gin (to_tsvector('english', text));

CREATE INDEX IF NOT EXISTS idx_memories_embedding_ivfflat
  ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

DROP TRIGGER IF EXISTS trg_memories_updated_at ON memories;
CREATE TRIGGER trg_memories_updated_at
BEFORE UPDATE ON memories
FOR EACH ROW
EXECUTE FUNCTION core_set_updated_at();

-- =====================================================================
-- Claims
-- =====================================================================

CREATE TABLE IF NOT EXISTS claims (
  claim_id              TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  subject_id            TEXT NOT NULL,
  predicate             TEXT NOT NULL,
  object_value          TEXT NOT NULL,
  slot                  TEXT NOT NULL,
  claim_type            TEXT NOT NULL DEFAULT 'fact',
  confidence            DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  importance            DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  source_memory_id      TEXT,
  source_observation_id TEXT,
  subject_entity        TEXT NOT NULL DEFAULT 'self',
  status                TEXT NOT NULL DEFAULT 'active',
  asserted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retracted_at          TIMESTAMPTZ,
  retract_reason        TEXT,
  embedding             VECTOR(1536),
  valid_from            TIMESTAMPTZ,
  valid_until           TIMESTAMPTZ,
  CONSTRAINT fk_claim_source_memory
    FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claims_status_check'
  ) THEN
    ALTER TABLE claims
    ADD CONSTRAINT claims_status_check
    CHECK (status IN ('active', 'retracted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_claims_project_subject
  ON claims(project_id, subject_id);

CREATE INDEX IF NOT EXISTS idx_claims_project_subject_slot
  ON claims(project_id, subject_id, slot, asserted_at DESC);

CREATE INDEX IF NOT EXISTS idx_claims_project_subject_predicate
  ON claims(project_id, subject_id, predicate, asserted_at DESC);

CREATE INDEX IF NOT EXISTS idx_claims_status
  ON claims(project_id, subject_id, status);

DROP TRIGGER IF EXISTS trg_claims_updated_at ON claims;
CREATE TRIGGER trg_claims_updated_at
BEFORE UPDATE ON claims
FOR EACH ROW
EXECUTE FUNCTION core_set_updated_at();

CREATE TABLE IF NOT EXISTS claim_assertions (
  assertion_id          TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  subject_id            TEXT NOT NULL,
  claim_id              TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  memory_id             TEXT REFERENCES memories(id) ON DELETE SET NULL,
  predicate             TEXT NOT NULL,
  object_type           TEXT NOT NULL DEFAULT 'string',
  value_string          TEXT,
  value_number          DOUBLE PRECISION,
  value_date            TIMESTAMPTZ,
  value_json            JSONB,
  confidence            DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  status                TEXT NOT NULL DEFAULT 'active',
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claim_assertions_object_type_check'
  ) THEN
    ALTER TABLE claim_assertions
    ADD CONSTRAINT claim_assertions_object_type_check
    CHECK (object_type IN ('string', 'number', 'date', 'json'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_claim_assertions_memory
  ON claim_assertions(project_id, memory_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_assertions_claim
  ON claim_assertions(project_id, claim_id);

CREATE TABLE IF NOT EXISTS claim_edges (
  edge_id               BIGSERIAL PRIMARY KEY,
  project_id            TEXT NOT NULL,
  subject_id            TEXT NOT NULL,
  from_claim_id         TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  to_claim_id           TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  edge_type             TEXT NOT NULL,
  weight                DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason_code           TEXT,
  reason_text           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, from_claim_id, to_claim_id, edge_type)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claim_edges_type_check'
  ) THEN
    ALTER TABLE claim_edges
    ADD CONSTRAINT claim_edges_type_check
    CHECK (edge_type IN ('supersedes', 'supports', 'duplicates', 'related', 'retracts'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_claim_edges_from
  ON claim_edges(project_id, from_claim_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_edges_to
  ON claim_edges(project_id, to_claim_id, created_at DESC);

CREATE TABLE IF NOT EXISTS slot_state (
  project_id            TEXT NOT NULL,
  subject_id            TEXT NOT NULL,
  slot                  TEXT NOT NULL,
  active_claim_id       TEXT REFERENCES claims(claim_id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  replaced_by_claim_id  TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(project_id, subject_id, slot)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'slot_state_status_check'
  ) THEN
    ALTER TABLE slot_state
    ADD CONSTRAINT slot_state_status_check
    CHECK (status IN ('active', 'superseded', 'retracted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_slot_state_subject
  ON slot_state(project_id, subject_id, status, updated_at DESC);

-- =====================================================================
-- Recall events (audit/analytics for memory use)
-- =====================================================================

CREATE TABLE IF NOT EXISTS memory_recall_events (
  event_id              TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  subject_id            TEXT NOT NULL,
  memory_id             TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_text           TEXT NOT NULL DEFAULT '',
  chat_id               TEXT NOT NULL DEFAULT '',
  message_index         INTEGER NOT NULL DEFAULT 0,
  chat_logged           BOOLEAN NOT NULL DEFAULT TRUE,
  similarity_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
  request_type          TEXT NOT NULL DEFAULT 'chat',
  model                 TEXT NOT NULL DEFAULT '',
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  recalled_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_recall_by_chat
  ON memory_recall_events(project_id, chat_id, recalled_at ASC);

CREATE INDEX IF NOT EXISTS idx_memory_recall_by_memory
  ON memory_recall_events(project_id, memory_id, recalled_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_recall_by_subject
  ON memory_recall_events(project_id, subject_id, recalled_at DESC);
