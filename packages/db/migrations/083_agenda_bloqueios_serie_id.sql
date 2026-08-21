-- Migration 083: agenda_bloqueios.serie_id para recorrência finita do portal.
--
-- Aditiva e reversível por convivência: preserva bloqueios simples e histórico
-- existente. Cada ocorrência da série continua sendo um bloqueio independente.

BEGIN;

ALTER TABLE agenda_bloqueios
  ADD COLUMN IF NOT EXISTS serie_id UUID;

COMMENT ON COLUMN agenda_bloqueios.serie_id IS
  'UUID compartilhado entre ocorrências independentes da mesma série de bloqueios do portal. NULL = bloqueio simples.';

CREATE INDEX IF NOT EXISTS ix_agenda_bloqueios_serie_future_active
  ON agenda_bloqueios (slot, tenant_id, serie_id, inicio_at)
  WHERE deleted_at IS NULL
    AND serie_id IS NOT NULL
    AND status IN ('active', 'gcal_cleanup_failed');

COMMIT;
