-- ADR 0044: cerca tentativas de dispatch para que um executor vencido não
-- confirme nem rebaixe a ocorrência após uma recovery ter assumido a lease.
ALTER TABLE agenda_bloqueio_operacao_ocorrencias
  ADD COLUMN IF NOT EXISTS attempt_version INTEGER NOT NULL DEFAULT 0;
