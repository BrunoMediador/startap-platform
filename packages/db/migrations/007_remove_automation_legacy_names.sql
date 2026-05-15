-- Migration 007: remove nomes legados da automacao visual.
-- Idempotente.

BEGIN;

DO $$
DECLARE
  legacy_prefix TEXT := 'n' || '8n_';
BEGIN
  IF to_regclass('public.chat_histories') IS NULL
     AND to_regclass('public.' || legacy_prefix || 'chat_histories') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I RENAME TO chat_histories', legacy_prefix || 'chat_histories');
  END IF;

  IF to_regclass('public.chat_histories_ricardo') IS NULL
     AND to_regclass('public.' || legacy_prefix || 'chat_histories_ricardo') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I RENAME TO chat_histories_ricardo', legacy_prefix || 'chat_histories_ricardo');
  END IF;

  IF to_regclass('public.chat_histories_vendas_barbearia') IS NULL
     AND to_regclass('public.' || legacy_prefix || 'chat_histories_vendas_barbearia') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I RENAME TO chat_histories_vendas_barbearia', legacy_prefix || 'chat_histories_vendas_barbearia');
  END IF;

  IF to_regclass('public.chat_histories_startap') IS NULL
     AND to_regclass('public.' || legacy_prefix || 'chat_histories_startap') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I RENAME TO chat_histories_startap', legacy_prefix || 'chat_histories_startap');
  END IF;

  IF to_regclass('public.chat_histories_controle_de_pause') IS NULL
     AND to_regclass('public.' || legacy_prefix || 'chat_histories_controle_de_pause') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I RENAME TO chat_histories_controle_de_pause', legacy_prefix || 'chat_histories_controle_de_pause');
  END IF;

  IF to_regclass('public.chat_histories_controle_de_pausee') IS NULL
     AND to_regclass('public.' || legacy_prefix || 'chat_histories_controle_de_pausee') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I RENAME TO chat_histories_controle_de_pausee', legacy_prefix || 'chat_histories_controle_de_pausee');
  END IF;

  IF to_regclass('public.chat_histories_controle_de_pauseee') IS NULL
     AND to_regclass('public.' || legacy_prefix || 'chat_histories_controle_de_pauseee') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.%I RENAME TO chat_histories_controle_de_pauseee', legacy_prefix || 'chat_histories_controle_de_pauseee');
  END IF;
END $$;

UPDATE project_databases
SET memory_table = replace(memory_table, 'n' || '8n_', ''),
    updated_at = NOW()
WHERE memory_table LIKE ('n' || '8n\_%') ESCAPE '\';

COMMIT;
