-- Migration 089: claim durável para criação idempotente de séries de bloqueios.
--
-- A tabela é aditiva. A chave não armazena sessão nem payload em claro: recebe
-- somente hashes SHA-256 calculados na API. Rollback quente = reverter o código;
-- a tabela permanece inerte, sem DROP.

BEGIN;

CREATE TABLE IF NOT EXISTS agenda_bloqueio_series (
  id               UUID        PRIMARY KEY,
  tenant_id        UUID        NOT NULL,
  slot             TEXT        NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  colaborador_key  BIGINT      NOT NULL,
  session_hash     TEXT        NOT NULL,
  payload_hash     TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'creating',
  response_status  SMALLINT,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agenda_bloqueio_series_status_check
    CHECK (status IN ('creating', 'complete', 'partial', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agenda_bloqueio_series_replay
  ON agenda_bloqueio_series (tenant_id, slot, colaborador_key, session_hash, payload_hash);

CREATE INDEX IF NOT EXISTS ix_agenda_bloqueio_series_scope
  ON agenda_bloqueio_series (tenant_id, slot, id);

COMMENT ON TABLE agenda_bloqueio_series IS
  'Claim durável de séries de bloqueio: deduplica replay por sessão hash, tenant, colaborador e payload hash, preservando resposta final sem PII.';

COMMIT;
