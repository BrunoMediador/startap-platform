-- Migration 006: controle global de fluxos e bancos logicos por projeto.
-- Idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS flow_controls (
  flow_id      VARCHAR(100) PRIMARY KEY,
  flow_name    VARCHAR(150) NOT NULL,
  source       VARCHAR(20) NOT NULL DEFAULT 'ts',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_controls_active ON flow_controls (active);

CREATE TABLE IF NOT EXISTS project_databases (
  project_id    VARCHAR(80) PRIMARY KEY,
  display_name  VARCHAR(150) NOT NULL,
  workflow_id   VARCHAR(100) NOT NULL,
  slot          VARCHAR(50) NOT NULL,
  source        VARCHAR(20) NOT NULL DEFAULT 'ts',
  memory_table  VARCHAR(100) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_databases_workflow ON project_databases (workflow_id);
CREATE INDEX IF NOT EXISTS idx_project_databases_slot ON project_databases (slot);

CREATE TABLE IF NOT EXISTS n8n_chat_histories (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  message JSONB
);
CREATE INDEX IF NOT EXISTS idx_chat_histories_session
  ON n8n_chat_histories (session_id, id DESC);

CREATE TABLE IF NOT EXISTS n8n_chat_histories_ricardo (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  message JSONB
);
CREATE INDEX IF NOT EXISTS idx_chat_histories_ricardo_session
  ON n8n_chat_histories_ricardo (session_id, id DESC);

CREATE TABLE IF NOT EXISTS n8n_chat_histories_startap (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  message JSONB
);
CREATE INDEX IF NOT EXISTS idx_chat_histories_startap_session
  ON n8n_chat_histories_startap (session_id, id DESC);

CREATE TABLE IF NOT EXISTS n8n_chat_histories_controle_de_pause (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  message JSONB
);
CREATE INDEX IF NOT EXISTS idx_chat_histories_controle_pause_session
  ON n8n_chat_histories_controle_de_pause (session_id, id DESC);

CREATE TABLE IF NOT EXISTS n8n_chat_histories_controle_de_pausee (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  message JSONB
);
CREATE INDEX IF NOT EXISTS idx_chat_histories_controle_pausee_session
  ON n8n_chat_histories_controle_de_pausee (session_id, id DESC);

CREATE TABLE IF NOT EXISTS n8n_chat_histories_controle_de_pauseee (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  message JSONB
);
CREATE INDEX IF NOT EXISTS idx_chat_histories_controle_pauseee_session
  ON n8n_chat_histories_controle_de_pauseee (session_id, id DESC);

INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at) VALUES
  ('0ni38aSspWwhooHd', 'teste_barbearia', 'ts', TRUE, NOW()),
  ('dlpKXM3gvX2joC1b', 'teste_vendas', 'ts', TRUE, NOW()),
  ('teste_vendas_barbearia', 'teste_vendas_barbearia', 'ts', TRUE, NOW()),
  ('uUS3Ux1cU2DquKxo', 'startap', 'ts', TRUE, NOW())
ON CONFLICT (flow_id) DO NOTHING;

INSERT INTO project_databases
  (project_id, display_name, workflow_id, slot, source, memory_table, status, metadata, updated_at)
VALUES
  (
    'teste_barbearia',
    'Teste - Barbearia',
    '0ni38aSspWwhooHd',
    'teste_barbearia',
    'ts',
    'n8n_chat_histories',
    'active',
    '{"category":"teste","tables":["chat_memory","routing","bot_prompt","model_usage","flow_logs","agendamento_pendente"]}'::jsonb,
    NOW()
  ),
  (
    'teste_vendas',
    'Teste - Vendas Curso',
    'dlpKXM3gvX2joC1b',
    'teste_vendas',
    'ts',
    'n8n_chat_histories_ricardo',
    'active',
    '{"category":"teste","tables":["chat_memory","routing","bot_prompt","bot_media","model_usage","flow_logs","leads_ricardo"]}'::jsonb,
    NOW()
  ),
  (
    'teste_vendas_barbearia',
    'Teste - Vendas + Barbearia',
    'teste_vendas_barbearia',
    'teste_vendas_barbearia',
    'ts',
    'n8n_chat_histories_vendas_barbearia',
    'active',
    '{"category":"teste","tables":["chat_memory","routing","bot_prompt","bot_media","model_usage","flow_logs","leads_vendas_barbearia"]}'::jsonb,
    NOW()
  ),
  (
    'startap',
    'Startap - Prospeccao',
    'uUS3Ux1cU2DquKxo',
    'startap',
    'ts',
    'n8n_chat_histories_startap',
    'active',
    '{"category":"interno","tables":["chat_memory","bot_prompt","model_usage","flow_logs","pause_startap"]}'::jsonb,
    NOW()
  )
ON CONFLICT (project_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  workflow_id = EXCLUDED.workflow_id,
  slot = EXCLUDED.slot,
  source = EXCLUDED.source,
  memory_table = EXCLUDED.memory_table,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS project_id VARCHAR(80);
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS flow_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_model_usage_project_time
  ON model_usage (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_flow_time
  ON model_usage (flow_id, created_at DESC);

UPDATE model_usage
SET project_id = CASE slot
    WHEN 'teste_barbearia' THEN 'teste_barbearia'
    WHEN 'teste_vendas' THEN 'teste_vendas'
    WHEN 'teste_vendas_barbearia' THEN 'teste_vendas_barbearia'
    WHEN 'startap' THEN 'startap'
    ELSE project_id
  END,
  flow_id = CASE slot
    WHEN 'teste_barbearia' THEN '0ni38aSspWwhooHd'
    WHEN 'teste_vendas' THEN 'dlpKXM3gvX2joC1b'
    WHEN 'teste_vendas_barbearia' THEN 'teste_vendas_barbearia'
    WHEN 'startap' THEN 'uUS3Ux1cU2DquKxo'
    ELSE flow_id
  END
WHERE project_id IS NULL OR flow_id IS NULL;

COMMIT;
