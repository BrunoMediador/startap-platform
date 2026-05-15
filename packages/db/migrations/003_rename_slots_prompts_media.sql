-- Migration 003: renomear slots, adicionar bot_prompt + bot_media, remover Samuel admin
-- Idempotente

BEGIN;

-- 1. Renomear slots existentes (preserva token usage history)
UPDATE bot_config SET slot = 'teste_barbearia', display_name = 'Teste — Barbearia'
  WHERE slot = 'barbearia-cirilo';
UPDATE model_usage SET slot = 'teste_barbearia' WHERE slot = 'barbearia-cirilo';

UPDATE bot_config SET slot = 'teste_vendas', display_name = 'Teste — Vendas (curso)'
  WHERE slot = 'elenildo-ricardo';
UPDATE model_usage SET slot = 'teste_vendas' WHERE slot = 'elenildo-ricardo';

UPDATE bot_config SET slot = 'startap', display_name = 'Startap — Prospecção (Lola)'
  WHERE slot = 'startap-ai-lola';
UPDATE model_usage SET slot = 'startap' WHERE slot = 'startap-ai-lola';

-- 2. Remover slot do Samuel admin (não está sendo usado)
DELETE FROM bot_config  WHERE slot = 'startap-ai-samuel';
DELETE FROM model_usage WHERE slot = 'startap-ai-samuel';

-- 3. Re-seed (caso slots novos nao existam ainda, ex. ambiente do zero)
INSERT INTO bot_config (slot, display_name, provider, model, temperature) VALUES
  ('teste_barbearia', 'Teste — Barbearia',         'openai',   'gpt-4o',        0.3),
  ('teste_vendas',    'Teste — Vendas (curso)',    'openai',   'gpt-4o',        0.5),
  ('startap',         'Startap — Prospecção (Lola)','deepseek', 'deepseek-chat', 0.5)
ON CONFLICT (slot) DO NOTHING;

-- 4. Nova tabela: prompt por slot (editável via painel)
CREATE TABLE IF NOT EXISTS bot_prompt (
  slot         VARCHAR(50) PRIMARY KEY REFERENCES bot_config(slot) ON DELETE CASCADE,
  prompt       TEXT NOT NULL,
  updated_at   TIMESTAMP DEFAULT NOW()
);

-- 5. Nova tabela: midias por slot (videos/imagens enviadas pelo bot)
CREATE TABLE IF NOT EXISTS bot_media (
  id           BIGSERIAL PRIMARY KEY,
  slot         VARCHAR(50) NOT NULL REFERENCES bot_config(slot) ON DELETE CASCADE,
  position     VARCHAR(20) NOT NULL,       -- 'V1','V2','V3','POS_VIDEOS', etc
  media_type   VARCHAR(20) NOT NULL DEFAULT 'video',  -- video|image|file|text
  url          TEXT,                       -- url da midia (text type usa caption)
  caption      TEXT,                       -- caption (ou texto puro se media_type=text)
  position_order INT NOT NULL DEFAULT 0,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE(slot, position)
);
CREATE INDEX IF NOT EXISTS idx_bot_media_slot ON bot_media (slot, position_order);

COMMIT;
