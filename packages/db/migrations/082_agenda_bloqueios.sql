-- Migration 082: agenda_bloqueios — bloqueios de agenda (almoço, ausência,
-- férias, indisponível), dormente por AGENDA_BLOQUEIOS_ENABLED.
--
-- Tabela NOVA e ADITIVA. Nenhuma rota usa isto com a flag ausente/OFF.
--
-- ISOLAMENTO:
--   - slot SEMPRE vem da sessão/API, nunca de body/query do cliente.
--   - tenant_id NOT NULL carimbado pelo caller a partir do clone/sessão.
--   - colaborador_id é opcional: NULL = agenda individual do clone; preenchido =
--     agenda de um profissional do estabelecimento.
--   - FKs compostos (slot, tenant_id, colaborador_id) e (slot, tenant_id,
--     created_by_colaborador_id) impedem referenciar colaborador de outro tenant.
--
-- gcal_event_id é UNIQUE só para linhas ativas (deleted_at IS NULL), permitindo
-- preservar histórico soft-deletado sem impedir reuso externo futuro.
--
-- NÃO destrutiva: nenhum comando de remoção de dado existente.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agenda_bloqueios (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID         NOT NULL,
  slot                       TEXT         NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  colaborador_id             BIGINT,
  gcal_event_id              TEXT,
  inicio_at                  TIMESTAMPTZ  NOT NULL,
  fim_at                     TIMESTAMPTZ  NOT NULL,
  timezone                   TEXT         NOT NULL DEFAULT 'America/Sao_Paulo',
  tipo                       TEXT         NOT NULL,
  motivo                     TEXT,
  status                     TEXT         NOT NULL DEFAULT 'creating',
  created_by_role            TEXT         NOT NULL,
  created_by_user_id         BIGINT,
  created_by_colaborador_id  BIGINT,
  deleted_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE agenda_bloqueios IS
  'Bloqueios de agenda criados pelo portal. Feature dormente por AGENDA_BLOQUEIOS_ENABLED; cada linha carrega slot + tenant_id.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agenda_bloqueios_periodo_check'
  ) THEN
    ALTER TABLE agenda_bloqueios
      ADD CONSTRAINT agenda_bloqueios_periodo_check CHECK (fim_at > inicio_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agenda_bloqueios_tipo_check'
  ) THEN
    ALTER TABLE agenda_bloqueios
      ADD CONSTRAINT agenda_bloqueios_tipo_check
      CHECK (tipo IN ('almoco', 'ausencia', 'ferias', 'indisponivel'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agenda_bloqueios_status_check'
  ) THEN
    ALTER TABLE agenda_bloqueios
      ADD CONSTRAINT agenda_bloqueios_status_check
      CHECK (status IN ('creating', 'active', 'gcal_failed', 'gcal_cleanup_failed', 'deleted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agenda_bloqueios_created_by_role_check'
  ) THEN
    ALTER TABLE agenda_bloqueios
      ADD CONSTRAINT agenda_bloqueios_created_by_role_check
      CHECK (created_by_role IN ('owner', 'colaborador'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_colab_slot_tenant_id
  ON clone_colaboradores (slot, tenant_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agenda_bloqueios_colaborador_scope_fk'
  ) THEN
    ALTER TABLE agenda_bloqueios
      ADD CONSTRAINT agenda_bloqueios_colaborador_scope_fk
      FOREIGN KEY (slot, tenant_id, colaborador_id)
      REFERENCES clone_colaboradores (slot, tenant_id, id)
      ON DELETE SET NULL (colaborador_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agenda_bloqueios_created_by_colaborador_scope_fk'
  ) THEN
    ALTER TABLE agenda_bloqueios
      ADD CONSTRAINT agenda_bloqueios_created_by_colaborador_scope_fk
      FOREIGN KEY (slot, tenant_id, created_by_colaborador_id)
      REFERENCES clone_colaboradores (slot, tenant_id, id)
      ON DELETE SET NULL (created_by_colaborador_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_agenda_bloqueios_gcal_event_active
  ON agenda_bloqueios (gcal_event_id)
  WHERE gcal_event_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_agenda_bloqueios_slot_tenant_interval_status
  ON agenda_bloqueios (slot, tenant_id, status, inicio_at, fim_at);

CREATE INDEX IF NOT EXISTS ix_agenda_bloqueios_tenant
  ON agenda_bloqueios (tenant_id);

CREATE INDEX IF NOT EXISTS ix_agenda_bloqueios_colaborador_interval_status
  ON agenda_bloqueios (slot, tenant_id, colaborador_id, status, inicio_at, fim_at);

CREATE INDEX IF NOT EXISTS ix_agenda_bloqueios_active_interval
  ON agenda_bloqueios (slot, tenant_id, inicio_at, fim_at)
  WHERE deleted_at IS NULL AND status = 'active';

COMMIT;
