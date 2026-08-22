-- Migration 092: fencing no nível da operação (ADR 0044).
-- Aditiva e forward-compatible: executores anteriores continuam cercados por
-- attempt_version da ocorrência até o código novo passar a usar este token.
BEGIN;

ALTER TABLE agenda_bloqueio_operacoes
  ADD COLUMN IF NOT EXISTS attempt_version INTEGER NOT NULL DEFAULT 0;

COMMIT;
