-- Migration 013: tabela de clones de fluxos matriz.
-- Idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS flow_clones (
  id               BIGSERIAL PRIMARY KEY,
  slot             VARCHAR(80)  UNIQUE NOT NULL REFERENCES bot_config(slot) ON DELETE CASCADE,
  matriz_slot      VARCHAR(80)  NOT NULL REFERENCES bot_config(slot) ON DELETE RESTRICT,
  display_name     VARCHAR(160) NOT NULL,
  cliente_nome     VARCHAR(160),
  cliente_telefone VARCHAR(32),
  personalizacao   JSONB NOT NULL DEFAULT '{}'::jsonb,
  waha_sessao      VARCHAR(80)  UNIQUE,
  status           VARCHAR(24)  NOT NULL DEFAULT 'rascunho',
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- status permitidos: rascunho | aguardando_qr | conectado | desconectado | falhou

CREATE INDEX IF NOT EXISTS idx_flow_clones_matriz ON flow_clones(matriz_slot);
CREATE INDEX IF NOT EXISTS idx_flow_clones_status ON flow_clones(status);

COMMIT;
