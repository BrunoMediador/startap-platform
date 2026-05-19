-- Migration 022 — Auditoria 2026-05-18
-- Corrige modelos errados, typo STARTTAP_AI e provider/model do slot startap.
--
-- ROLLBACK (comentado — aplicar manualmente se necessário):
--   UPDATE bot_config SET model = 'gpt-4o'
--     WHERE slot IN ('teste_barbearia', 'teste_vendas', 'teste_vendas_barbearia');
--   UPDATE bot_config SET model = 'gpt-5.4'
--     WHERE slot = 'startap' AND provider = 'deepseek';
--   UPDATE flow_execution_logs SET flow_name = 'STARTTAP_AI'
--     WHERE flow_name = 'STARTAP_AI';

-- Diagnóstico: estado antes
SELECT slot, provider, model FROM bot_config
WHERE slot IN ('startap', 'teste_barbearia', 'teste_vendas', 'teste_vendas_barbearia')
ORDER BY slot;

-- Task 4: bot_config startap — provider=deepseek precisa model=deepseek-chat (não gpt-5.4)
UPDATE bot_config
  SET model = 'deepseek-chat', updated_at = NOW()
  WHERE slot = 'startap'
    AND provider = 'deepseek'
    AND model != 'deepseek-chat';

-- Task 20: bots de teste ainda com gpt-4o → gpt-5.4
UPDATE bot_config
  SET model = 'gpt-5.4', updated_at = NOW()
  WHERE slot IN ('teste_barbearia', 'teste_vendas', 'teste_vendas_barbearia')
    AND model = 'gpt-4o';

-- Task 24: corrige typo STARTTAP_AI → STARTAP_AI em flow_execution_logs e flow_pauses
-- (941 eventos identificados na auditoria)
UPDATE flow_execution_logs
  SET flow_name = 'STARTAP_AI'
  WHERE flow_name = 'STARTTAP_AI';

UPDATE flow_pauses
  SET flow_name = 'STARTAP_AI'
  WHERE flow_name = 'STARTTAP_AI';

-- Diagnóstico: estado depois
SELECT slot, provider, model FROM bot_config
WHERE slot IN ('startap', 'teste_barbearia', 'teste_vendas', 'teste_vendas_barbearia')
ORDER BY slot;

SELECT COUNT(*) AS starttap_ai_restantes
  FROM flow_execution_logs
  WHERE flow_name = 'STARTTAP_AI';
