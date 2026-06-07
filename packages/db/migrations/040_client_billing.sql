-- Migration 040: billing/vencimento por fluxo (cliente).
--
-- Missao 009 / ADR 0012 (Decisao 3). Tabela separada de flow_clones porque
-- billing e dominio distinto e crescera (historico, gateway, NF). Misturar em
-- flow_clones poluiria o hot path do webhook (lido a cada mensagem).
--
-- 1 linha por slot. Bruno registra pagamento manualmente no painel-admin
-- (PUT /api/billing/:slot). O portal SO LE next_due_date / status.
--
-- IMPORTANTE (ADR Decisao 3): client_billing.status e INFORMATIVO. O que de fato
-- silencia o bot continua sendo flow_clones.flow_enabled (feature 30/05). Os dois
-- conceitos ficam DESACOPLADOS — nenhuma suspensao automatica por vencimento na v1.
--
-- Idempotente: CREATE TABLE IF NOT EXISTS. Aditiva: nao toca tabela existente.
--
-- Rollback (reversivel):
--   DROP TABLE IF EXISTS client_billing;

BEGIN;

CREATE TABLE IF NOT EXISTS client_billing (
  slot            VARCHAR(80)  PRIMARY KEY REFERENCES flow_clones(slot) ON DELETE CASCADE,
  next_due_date   DATE,
  amount_cents    INTEGER,
  last_payment_at TIMESTAMPTZ,
  status          VARCHAR(24)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'overdue', 'suspended')),
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (amount_cents IS NULL OR amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_client_billing_next_due
  ON client_billing (next_due_date);

COMMIT;
