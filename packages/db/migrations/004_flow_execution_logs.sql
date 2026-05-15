-- Migration 004: operational flow execution logs for the admin panel.
-- Idempotent; safe to run more than once.

CREATE TABLE IF NOT EXISTS flow_execution_logs (
  id              BIGSERIAL PRIMARY KEY,
  execution_id    UUID NOT NULL,
  flow_id         VARCHAR(100),
  flow_name       VARCHAR(150),
  bot             VARCHAR(100),
  telefone_masked VARCHAR(32),
  session         VARCHAR(100),
  event_type      VARCHAR(80) NOT NULL,
  status          VARCHAR(20) NOT NULL CHECK (status IN ('running','success','error','ignored')),
  message         TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms     INTEGER,
  error_summary   TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_logs_created ON flow_execution_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_logs_execution ON flow_execution_logs (execution_id, id);
CREATE INDEX IF NOT EXISTS idx_flow_logs_status ON flow_execution_logs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_logs_flow ON flow_execution_logs (flow_id, created_at DESC);
