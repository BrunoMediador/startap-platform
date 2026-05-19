-- Migration 023: colunas de credenciais Google Calendar em bot_config (matrizes)
-- Espelha as mesmas 6 colunas de flow_clones (migration 018), permitindo que
-- matrizes também usem Service Account própria em vez do OAuth global do Samuel.

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS gcal_credentials_json TEXT,
  ADD COLUMN IF NOT EXISTS gcal_client_email     TEXT,
  ADD COLUMN IF NOT EXISTS gcal_calendar_id      TEXT,
  ADD COLUMN IF NOT EXISTS gcal_status           TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS gcal_connected_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gcal_last_check_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bot_config_gcal_status ON bot_config(gcal_status);
