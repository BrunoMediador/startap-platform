-- Migration 041: billing_charges — ledger das cobrancas PIX geradas no gateway.
--
-- ADR 0013 (Pagamento PIX via AbacatePay) / Fase 1 (fundacao).
--
-- 1 cobranca PIX por (slot, ciclo). client_billing continua a FONTE DA VERDADE do
-- valor e do vencimento (lida no hot path); billing_charges e o LEDGER de cobrancas
-- geradas no gateway — cresce com historico e e dado de integracao. Nao misturar.
--
-- amount_cents AQUI e SNAPSHOT do valor congelado no momento da geracao do ciclo
-- (controle do threat-model): mesmo que o Bruno mude client_billing.amount_cents
-- depois, o ciclo corrente cobra o valor congelado. Pagamento NUNCA referencia
-- client_billing em tempo de conferencia — sempre o snapshot da propria cobranca.
--
-- UNIQUE (slot, cycle): idempotencia da geracao — 1 cobranca por (slot, ciclo).
-- "Cria se nao existe" no servico respeita esse UNIQUE (ON CONFLICT DO NOTHING).
--
-- ISOLAMENTO / RLS (divida P0): `slot` e a TENANT KEY desta tabela (FK para
-- flow_clones). NAO ha tenant_id/RLS nesta feature (decisao do ADR 0013: nao
-- misturar risco financeiro com rewrite global de isolamento). Quando o ADR de
-- RLS chegar, billing_charges entra no escopo da POLICY com `slot` como tenant key
-- natural — sem retrabalho. Esta migration NAO piora a postura de RLS.
--
-- NOTA F2 (fora do escopo desta migration): a dedupe de webhook
-- (billing_webhook_events) e a categoria estruturada de suspensao
-- (suspended_kind) sao de fases seguintes (webhook + auto-resume). NAO criadas aqui.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS. Aditiva: nao toca tabela existente.
--
-- Rollback (reversivel — nunca dropar na mesma release que cria):
--   DROP TABLE IF EXISTS billing_charges;

BEGIN;

CREATE TABLE IF NOT EXISTS billing_charges (
  id                 BIGSERIAL    PRIMARY KEY,
  slot               VARCHAR(80)  NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  cycle              CHAR(7)      NOT NULL,                  -- 'YYYY-MM' do ciclo cobrado
  external_id        VARCHAR(120) NOT NULL,                  -- "{slot}-{YYYY-MM}" enviado ao gateway
  abacate_charge_id  VARCHAR(120),                           -- 'pix_char_*' retornado na criacao
  amount_cents       INTEGER      NOT NULL CHECK (amount_cents > 0),  -- snapshot congelado do ciclo
  paid_amount_cents  INTEGER,                                -- preenchido no PAID (paidAmount) — F2
  status             VARCHAR(16)  NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  br_code            TEXT,                                   -- copia-e-cola PIX
  br_code_base64     TEXT,                                   -- QR (data-URI)
  expires_at         TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Idempotencia da geracao: 1 cobranca por (slot, ciclo). O servico de geracao usa
-- INSERT ... ON CONFLICT (slot, cycle) DO NOTHING e retorna a existente se ja houver.
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_charges_slot_cycle
  ON billing_charges (slot, cycle);

-- Lookups por slot (lista no portal/painel) e por status (reconciliacao F2).
CREATE INDEX IF NOT EXISTS idx_billing_charges_slot
  ON billing_charges (slot);
CREATE INDEX IF NOT EXISTS idx_billing_charges_status
  ON billing_charges (status);
CREATE INDEX IF NOT EXISTS idx_billing_charges_external_id
  ON billing_charges (external_id);

COMMIT;
