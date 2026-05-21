-- Migration 035: histórico de versões de bot_prompt para rollback
-- Idempotente: CREATE IF NOT EXISTS + ON CONFLICT DO NOTHING

CREATE TABLE IF NOT EXISTS bot_prompt_versions (
  id        BIGSERIAL PRIMARY KEY,
  slot      VARCHAR(80) NOT NULL,
  version   INTEGER     NOT NULL,
  prompt    TEXT        NOT NULL,
  edited_by TEXT,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  comment   TEXT,
  UNIQUE (slot, version)
);

CREATE INDEX IF NOT EXISTS idx_bot_prompt_versions_slot
  ON bot_prompt_versions(slot, version DESC);

-- Backfill: cria versão 1 para cada prompt existente em bot_prompt
INSERT INTO bot_prompt_versions (slot, version, prompt, edited_by, edited_at, comment)
SELECT slot, 1, prompt, 'migration', updated_at, 'snapshot inicial pre-versioning'
FROM bot_prompt
ON CONFLICT (slot, version) DO NOTHING;
