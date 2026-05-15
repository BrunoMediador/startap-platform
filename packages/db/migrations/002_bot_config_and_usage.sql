-- Migration 002: bot_config + model_usage
-- Aplicada em prod em 2026-05-14.
-- Idempotente — pode rodar várias vezes sem efeito.

CREATE TABLE IF NOT EXISTS bot_config (
  slot          VARCHAR(50) PRIMARY KEY,
  display_name  VARCHAR(100) NOT NULL,
  provider      VARCHAR(20)  NOT NULL CHECK (provider IN ('openai','deepseek')),
  model         VARCHAR(100) NOT NULL,
  temperature   NUMERIC(3,2) DEFAULT 0.3,
  updated_at    TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_usage (
  id                BIGSERIAL PRIMARY KEY,
  slot              VARCHAR(50) NOT NULL,
  provider          VARCHAR(20) NOT NULL,
  model             VARCHAR(100) NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(12,6),
  telefone          VARCHAR(20),
  created_at        TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_model_usage_slot_time ON model_usage (slot, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_created  ON model_usage (created_at DESC);

-- Seed inicial dos 4 slots conhecidos
INSERT INTO bot_config (slot, display_name, provider, model, temperature) VALUES
  ('barbearia-cirilo',   'Cirilo (Barbearia)',          'openai',   'gpt-4o',        0.3),
  ('elenildo-ricardo',   'Ricardo (Curso Barbeiro)',    'openai',   'gpt-4o',        0.5),
  ('startap-ai-lola',    'Lola (Prospecção Startap)',   'deepseek', 'deepseek-chat', 0.5),
  ('startap-ai-samuel',  'Samuel Admin (pausa)',        'openai',   'gpt-4o',        0.3)
ON CONFLICT (slot) DO NOTHING;
