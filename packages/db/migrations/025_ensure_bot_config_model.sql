-- Migration 025: garante coluna model em flow_clones.
-- bot_config.model já existe (usada desde migration 022).
-- Idempotente via ADD COLUMN IF NOT EXISTS.

ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS model TEXT;

CREATE INDEX IF NOT EXISTS idx_flow_clones_model ON flow_clones(model)
  WHERE model IS NOT NULL;
