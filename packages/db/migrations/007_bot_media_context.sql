-- Migration 007: contexto interno para decisao de envio de midias.
-- Idempotente.

BEGIN;

ALTER TABLE bot_media
  ADD COLUMN IF NOT EXISTS context TEXT;

COMMENT ON COLUMN bot_media.context IS
  'Contexto interno da midia para a IA decidir quando enviar. Nao e enviado ao cliente.';

COMMIT;
