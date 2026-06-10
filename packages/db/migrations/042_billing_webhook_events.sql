-- Migration 042: billing_webhook_events (dedupe de webhook) + flow_clones.suspended_kind.
--
-- ADR 0013 (Pagamento PIX via AbacatePay) / Fase 2 (webhook + auto-reativacao).
-- Threat-model controles C1 (suspended_kind) e C4/C5 (dedupe + payload redigido).
--
-- ── billing_webhook_events (C4 — idempotencia / dedupe) ───────────────────────
-- 1 linha por envelope-id ja processado. PRIMARY KEY (event_id) = a BARREIRA de
-- idempotencia: INSERT ... ON CONFLICT (event_id) DO NOTHING dentro da transacao
-- do handler decide se este envelope (retry com backoff do gateway) ja foi tratado.
-- 0 linhas inseridas => replay => o handler responde 200 e sai sem reprocessar.
--
-- `payload` e REDIGIDO antes de gravar (C5 — LGPD): o handler remove CPF/email/
-- telefone/brCode/brCodeBase64 e mantem so o minimo de auditoria (status, valores,
-- externalId, ids). Esta migration NAO assume o payload bruto — a redacao mora no
-- codigo (apps/api). A coluna existe so para forense do minimo necessario.
--
-- ── flow_clones.suspended_kind (C1 — categoria estruturada) ───────────────────
-- Auto-resume do webhook SO age se suspended_kind='billing'. NUNCA por string-match
-- em suspended_reason (texto livre — risco de falso-resume A1/P0 do threat-model).
-- Nullable + sem default: clones nunca suspensos ficam NULL; suspensoes atuais
-- (Cirilo etc.) ficam NULL ate o BACKFILL MANUAL DO BRUNO. Enquanto NULL, auto-resume
-- NAO dispara (default seguro) — nenhuma reativacao automatica antes do backfill.
-- CHECK restringe aos motivos validos; 'billing' e o unico que o webhook reativa.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS. Aditiva.
-- NAO dropa nem altera coluna existente (regra de ouro 9 — reversivel).
--
-- Rollback (reversivel — nunca dropar na mesma release que cria):
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS suspended_kind;
--   DROP TABLE IF EXISTS billing_webhook_events;

BEGIN;

-- Dedupe de webhook (C4). charge_id e nullable: um evento orfao (sem cobranca
-- casada) ainda e registrado pra nao reprocessar em retry.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id     VARCHAR(120) PRIMARY KEY,                 -- envelope.id da AbacatePay (dedupe)
  event        VARCHAR(60)  NOT NULL,                     -- tipo do evento (ex 'transparent.completed')
  charge_id    BIGINT       REFERENCES billing_charges(id) ON DELETE SET NULL,
  received_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),       -- quando o webhook chegou
  processed_at TIMESTAMPTZ,                               -- quando terminou de processar (NULL = em voo/erro)
  payload      JSONB                                      -- payload REDIGIDO (sem CPF/email/telefone/brCode) — C5
);

CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_charge
  ON billing_webhook_events (charge_id);
CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_received
  ON billing_webhook_events (received_at DESC);

-- Categoria estruturada de suspensao (C1). Nullable, sem default — backfill manual
-- do Bruno pros suspensos atuais. NULL => auto-resume nao dispara (default seguro).
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS suspended_kind VARCHAR(20)
    CHECK (suspended_kind IN ('billing', 'owner_request', 'manual_other', 'abuse'));

COMMIT;
