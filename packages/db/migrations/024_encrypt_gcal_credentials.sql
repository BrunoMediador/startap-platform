-- Migration 024: registro de passo de criptografia gcal_credentials_json
--
-- ATENÇÃO: esta migration SQL apenas registra que o passo de criptografia
-- deve/foi executado. O trabalho real é feito pelo script TS:
--   scripts/encrypt-existing-gcal.ts
--
-- ORDEM DE EXECUÇÃO (deploy seguro):
--   1. Adicionar GCAL_ENCRYPTION_KEY ao .env do servidor (antes do deploy).
--      Gerar chave: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
--   2. Deploy normal (apps/api, painel-admin) — código novo já criptografa escritas novas.
--   3. Rodar UMA VEZ no servidor:
--        npx tsx scripts/encrypt-existing-gcal.ts
--      O script relê cada linha com gcal_credentials_json sem prefixo "enc:v1:",
--      criptografa e faz UPDATE parametrizado. Idempotente (pula linhas já cifradas).
--   4. Verificar no psql:
--        SELECT id, LEFT(gcal_credentials_json, 20) FROM flow_clones WHERE gcal_credentials_json IS NOT NULL;
--        SELECT slot, LEFT(gcal_credentials_json, 20) FROM bot_config WHERE gcal_credentials_json IS NOT NULL;
--      Todas as linhas devem começar com "enc:v1:".
--
-- Esta migration não altera schema — apenas documenta o passo operacional.
-- A coluna permanece TEXT (enc:v1: é detectado em runtime pelo código).

-- Tabela de log de migrações operacionais (idempotente)
CREATE TABLE IF NOT EXISTS operational_migration_log (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes       TEXT
);

INSERT INTO operational_migration_log (name, notes)
VALUES (
  '024_encrypt_gcal_credentials',
  'Placeholder registrado pela migration SQL. Execução real via scripts/encrypt-existing-gcal.ts'
)
ON CONFLICT (name) DO NOTHING;
