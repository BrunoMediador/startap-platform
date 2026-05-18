-- Adiciona coluna chat_table em flow_clones para que o cleanup job
-- saiba qual tabela de histórico pertence a cada clone sem depender
-- de KNOWN_CHAT_TABLES hardcoded.
ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS chat_table TEXT;

UPDATE flow_clones
SET chat_table = CASE
  WHEN matriz_slot = 'teste_barbearia'        THEN 'chat_histories'
  WHEN matriz_slot = 'teste_vendas'           THEN 'chat_histories_ricardo'
  WHEN matriz_slot = 'teste_vendas_barbearia' THEN 'chat_histories_vendas_barbearia'
  WHEN matriz_slot = 'startap'                THEN 'chat_histories_startap'
  ELSE 'chat_histories'
END
WHERE chat_table IS NULL;

CREATE INDEX IF NOT EXISTS idx_flow_clones_chat_table ON flow_clones(chat_table);
