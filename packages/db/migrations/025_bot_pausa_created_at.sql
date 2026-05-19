-- Migration 025 — Adiciona created_at em bot_pausa para permitir cleanup periódico
--
-- bot_pausa é tabela legada sem coluna de timestamp. O job de cleanup periódico
-- (D9) precisa de created_at para remover entradas antigas com segurança.
-- Linhas existentes recebem NOW() como valor retroativo (conservador: não serão
-- limpas até passarem o período de retenção a partir desta migration).

ALTER TABLE bot_pausa ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE bot_pausa SET created_at = NOW() WHERE created_at IS NULL;
