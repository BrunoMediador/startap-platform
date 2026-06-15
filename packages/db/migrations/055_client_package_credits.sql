-- Migration 055: client_package_credits — INSTÂNCIA de pacote comprada por um cliente final.
--
-- ADR 0025 (pacotes de serviço). BLOCO 2a (modelo + consulta read-only). A escrita
-- de saldo / dedução é o bloco 2b (NÃO neste PR — aqui só criamos o schema).
--
-- Tabela NOVA. Toda linha carrega slot + tenant_id UUID. O número do cliente final
-- NUNCA persiste cru (LGPD): só cliente_phone_hmac (HMAC-SHA256 com pepper PRÓPRIO de
-- pacotes — PACKAGE_PHONE_PEPPER, distinto de TRIAL_PHONE_PEPPER, ver ADR 0025 §4) +
-- cliente_phone_hint (DDD + 2 últimos dígitos) p/ suporte.
--
-- Por que pepper PRÓPRIO (não reusa o do trial): reusar a mesma chave faria o MESMO
--   número gerar o MESMO hash em trial_ledger e aqui -> join trivial cross-finalidade
--   (anti-trial-farming vs. identidade de saldo). Peppers separados impedem esse join
--   (minimização/LGPD). Como o do trial, o pepper de pacotes NUNCA rotaciona.
--
-- SALDO: sessoes_restantes é DERIVADO do ledger (package_redemptions); é cache de
--   sessoes_total + SUM(delta), reconstruível. Nesta migration NADA escreve nas duas
--   tabelas (bloco 2b). O CHECK garante que o cache nunca sai da faixa [0..total].
--
-- ISOLAMENTO:
--   - FK package_id -> service_packages(id): instância pertence a um template.
--   - INDEX(slot, cliente_phone_hmac): lookup O(1) dos créditos de UM telefone num slot
--     (caminho da consulta read-only e, no 2b, da dedução).
--
-- Idempotente: CREATE TABLE / CREATE INDEX IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE. Nenhum NOT NULL/FK sobre dado existente.
--
-- ── ROLLBACK (manual; release separada; só com aprovação do Bruno) ──────────────────
--   BEGIN;
--     DROP TABLE IF EXISTS client_package_credits CASCADE;  -- (cascade some redenções)
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS client_package_credits (
  id                  BIGSERIAL    PRIMARY KEY,
  package_id          BIGINT       NOT NULL REFERENCES service_packages(id),
  slot                TEXT         NOT NULL,
  tenant_id           UUID         NOT NULL,
  cliente_phone_hmac  TEXT         NOT NULL,                 -- HMAC-SHA256 (pepper PRÓPRIO de pacotes)
  cliente_phone_hint  VARCHAR(24),                           -- "+55 31 •••••-••42" p/ suporte
  sessoes_total       SMALLINT     NOT NULL,
  sessoes_restantes   SMALLINT     NOT NULL,                 -- DERIVADO do ledger; nunca UPDATE solto
  data_compra         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  data_expiracao      DATE         NOT NULL,
  status              VARCHAR(16)  NOT NULL DEFAULT 'active', -- active|expired|exhausted|cancelled
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (sessoes_restantes BETWEEN 0 AND sessoes_total)
);

COMMENT ON TABLE client_package_credits IS
  'Pacote comprado por um cliente final (ADR 0025). Número só como HMAC (pepper PRÓPRIO '
  'PACKAGE_PHONE_PEPPER) + hint. sessoes_restantes é cache do ledger (package_redemptions).';

-- Lookup dos créditos de um telefone dentro de um slot (consulta read-only + dedução 2b).
CREATE INDEX IF NOT EXISTS ix_credit_slot_phone
  ON client_package_credits (slot, cliente_phone_hmac);

COMMIT;
