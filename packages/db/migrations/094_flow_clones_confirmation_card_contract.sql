-- Migration 094: contrato estruturado do cartão de confirmação server-first por clone/slot.
--
-- ADR 0046 — clones baked/custom podem declarar explicitamente a cópia que o servidor
-- renderiza depois da proposta. Não há backfill: NULL mantém cada clone no caminho baked
-- atual, byte-a-byte. O app só aceita contrato versionado, segmentos fechados e precondição
-- SHA-256 do cartão baked; qualquer forma inválida falha fechada.
--
-- O contrato mora em flow_clones (uma linha por slot, já ancorada a tenant_id) e não recebe
-- dados de cliente/conversa. Valores dinâmicos são injetados só do estado canônico validado
-- no servidor. Telemetria não registra o conteúdo do contrato.
--
-- Rollback (release separada, com aprovação explícita):
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS confirmation_card_contract;

BEGIN;

ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS confirmation_card_contract JSONB;

COMMENT ON COLUMN flow_clones.confirmation_card_contract IS
  'ADR 0046: contrato versionado do cartão server-first por slot. NULL mantém baked atual; app valida segmentos, hash do cartão baked e falha fechada.';

COMMIT;
