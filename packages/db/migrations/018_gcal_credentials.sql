-- Migration 018: colunas de credenciais Google Calendar por clone
-- Service Account JSON armazenado criptografado em gcal_credentials_json.
-- client_email extraído no momento do PUT para exibição sem expor o JSON.

ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS gcal_credentials_json TEXT,
  ADD COLUMN IF NOT EXISTS gcal_client_email     TEXT,
  ADD COLUMN IF NOT EXISTS gcal_calendar_id      TEXT,
  ADD COLUMN IF NOT EXISTS gcal_status           TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS gcal_connected_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gcal_last_check_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_flow_clones_gcal_status ON flow_clones(gcal_status);
