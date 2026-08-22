-- Migration 090: state machine durável de séries de bloqueio (ADR 0044).
-- Aditiva e forward-compatible com 089: código antigo continua usando a tabela anterior.
BEGIN;

CREATE TABLE IF NOT EXISTS agenda_bloqueio_operacoes (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  slot TEXT NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  colaborador_key BIGINT NOT NULL,
  session_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'colaborador')),
  actor_user_id BIGINT,
  actor_colaborador_id BIGINT,
  timezone TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('almoco', 'ausencia', 'ferias', 'indisponivel')),
  motivo TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'creating', 'complete', 'partial', 'recovery_required', 'failed_final')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slot, colaborador_key, session_hash, payload_hash)
);

CREATE TABLE IF NOT EXISTS agenda_bloqueio_operacao_ocorrencias (
  operation_id UUID NOT NULL REFERENCES agenda_bloqueio_operacoes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  inicio_at TIMESTAMPTZ NOT NULL,
  fim_at TIMESTAMPTZ NOT NULL CHECK (fim_at > inicio_at),
  bloqueio_id UUID NOT NULL,
  gcal_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'gcal_dispatch_started', 'active', 'recovery_required')),
  error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, ordinal),
  UNIQUE (gcal_event_id)
);

CREATE INDEX IF NOT EXISTS ix_agenda_bloqueio_operacoes_scope
  ON agenda_bloqueio_operacoes (tenant_id, slot, id);
CREATE INDEX IF NOT EXISTS ix_agenda_bloqueio_operacao_ocorrencias_recovery
  ON agenda_bloqueio_operacao_ocorrencias (operation_id, status, ordinal);
COMMIT;
