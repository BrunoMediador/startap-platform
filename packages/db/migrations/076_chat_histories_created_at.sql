-- Migration 076: created_at nas tabelas de histórico de chat (SCRUM-136, LGPD).
--
-- Habilita a retenção por IDADE das mensagens de clientes finais. As tabelas
-- chat_histories* nasceram (migration 006) só com (id, session_id, message) — sem
-- carimbo de tempo, então não dava pra saber a idade de uma conversa. Adiciona
-- created_at TIMESTAMPTZ NOT NULL DEFAULT now() em TODAS as tabelas chat_histories*
-- do schema, INCLUSIVE tabelas órfãs de clones excluídos (varre pg_tables, não uma
-- lista fixa).
--
-- CONSERVADOR DE PROPÓSITO: linhas pré-existentes recebem created_at = momento da
-- migration (default avaliado no ALTER). Logo, dados antigos só passam a envelhecer
-- a partir do deploy — nada fica elegível à retenção antes de CHAT_RETENTION_DAYS
-- contados a partir de agora. Não é destrutivo (só ADD COLUMN + índice).
--
-- Reversível: rollback = feature desligada por env (CHAT_RETENTION_ENABLED off, que já
-- é o default). A coluna pode permanecer (inócua) e só ser dropada numa release POSTERIOR.
-- Idempotente (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

BEGIN;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^chat_histories(_[a-z0-9_]+)?$'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      t
    );
    -- Índice pró retenção (filtro por created_at). Nome truncado a 63 bytes pelo PG se preciso.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (created_at)',
      left('idx_' || t || '_created_at', 63),
      t
    );
  END LOOP;
END $$;

COMMIT;
