-- Migration 038: suspender fluxo sem desconectar WhatsApp
-- Motivação: cliente inadimplente / férias / pausa temporária de faturamento.
-- flow_enabled=false silencia o bot (silêncio total) sem tocar na sessão WAHA.
-- Default true — feature aditiva, nenhum clone suspenso no rollout.
--
-- Rollback:
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS flow_enabled;
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS suspended_reason;
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS suspended_at;
--   DROP TABLE IF EXISTS flow_suspension_log;
--   DROP INDEX IF EXISTS idx_flow_clones_flow_enabled;

ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS flow_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS suspended_reason text,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_flow_clones_flow_enabled
  ON flow_clones(flow_enabled) WHERE flow_enabled = false;

CREATE TABLE IF NOT EXISTS flow_suspension_log (
  id bigserial PRIMARY KEY,
  slot varchar(80) NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  action varchar(16) NOT NULL CHECK (action IN ('suspend', 'resume')),
  reason text,
  actor varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_suspension_log_slot_created
  ON flow_suspension_log(slot, created_at DESC);
