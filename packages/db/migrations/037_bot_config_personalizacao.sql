-- Migration 037: adiciona coluna personalizacao em bot_config.
-- Permite que a matriz tenha seus proprios valores de personalizacao
-- (chave-valor JSON) como template, espelhando o que ja existe em flow_clones.
-- Idempotente: ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS personalizacao JSONB;
