-- Migration 021: adiciona waha_sessao em bot_config para mapear slot → session.name no WAHA
--
-- Causa-raiz: bot_config.slot (ex: 'startap') diverge de session.name no WAHA
-- (ex: 'STARTAP_AI_PROD'), causando waha_status: null em /api/bots (auditoria #007).
-- Três slots de teste compartilham a mesma sessão WAHA ('WHATSAPP_ROUTER_TESTE')
-- pois o router diferencia por telefone, não por sessão.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE com WHERE idempotente.
-- Reversível: não dropa nada; remover a coluna é ALTER TABLE DROP COLUMN.

BEGIN;

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS waha_sessao VARCHAR(80);

-- Mapeamento prod descoberto em 2026-05-18 (auditoria missão 007):
UPDATE bot_config
SET waha_sessao = 'STARTAP_AI_PROD'
WHERE slot = 'startap' AND waha_sessao IS NULL;

UPDATE bot_config
SET waha_sessao = 'WHATSAPP_ROUTER_TESTE'
WHERE slot IN ('teste_barbearia', 'teste_vendas', 'teste_vendas_barbearia')
  AND waha_sessao IS NULL;

COMMIT;
