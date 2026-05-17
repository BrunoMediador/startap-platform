-- Migration 015: consolida slots legados em bot_config.
-- Idempotente — re-rodar e no-op se ja consolidado.
--
-- Contexto: migration 002 inseriu 4 slots legados (barbearia-cirilo, elenildo-ricardo,
-- startap-ai-lola, startap-ai-samuel). Migration 003 deveria ter renomeado/deletado,
-- mas em prod uma re-execucao manual da 002 (antes do runner existir) re-criou as
-- rows legadas em paralelo com os slots novos.
--
-- Hoje (2026-05-17) os 4 legados estao em bot_config com calls=0 nos ultimos 30 dias,
-- enquanto os novos (teste_barbearia, teste_vendas, startap) recebem todo o trafego.
-- O painel mostra 4 cards sempre zerados — ruido visual sem efeito funcional.
--
-- Detalhes da investigacao em docs/audit-startap-lola.md.

BEGIN;

-- 1. Move historico de tokens dos legados para os novos slots (preserva metricas).
--    Evita perda de historico ao apagar bot_config legado (model_usage NAO tem FK
--    em bot_config, entao a row de model_usage sobreviveria orfa).
UPDATE model_usage SET slot = 'teste_barbearia' WHERE slot = 'barbearia-cirilo';
UPDATE model_usage SET slot = 'teste_vendas'    WHERE slot = 'elenildo-ricardo';
UPDATE model_usage SET slot = 'startap'         WHERE slot = 'startap-ai-lola';

-- Samuel admin nao tem equivalente novo (nao foi migrado para a plataforma TS) —
-- historico e descartado. Confirmado via /api/usage/summary?days=30: zero calls.
DELETE FROM model_usage WHERE slot = 'startap-ai-samuel';

-- 2. Apaga as 4 rows legadas em bot_config.
--    CASCADE em bot_prompt e bot_media remove prompts e midias associadas
--    (tambem legadas, nao usadas pelo runtime atual).
DELETE FROM bot_config
WHERE slot IN (
  'barbearia-cirilo',
  'elenildo-ricardo',
  'startap-ai-lola',
  'startap-ai-samuel'
);

COMMIT;
