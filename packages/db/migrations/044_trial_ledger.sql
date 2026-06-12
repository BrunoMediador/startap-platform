-- Migration 044: trial_ledger (trava anti trial-farming) + flow_clones.trial_status.
--
-- Missão 020 F1 (onboarding self-service com trial de 10 dias).
-- Desenho: docs/missoes/020-onboarding-self-service.md (seção "Requisito duro").
--
-- trial_ledger — registro PERMANENTE de números que consumiram o teste grátis:
--   * phone_hmac  = HMAC-SHA256(pepper server-side TRIAL_PHONE_PEPPER, E.164 canônico).
--     O número cru NUNCA é gravado (LGPD art. 7º IX — prevenção a fraude). Lookup
--     exato continua O(1) (HMAC é determinístico). ATENÇÃO: o pepper NUNCA rotaciona
--     (rotação invalida todos os lookups) — ver .env.example.
--   * phone_hint  = "+55 31 •••••-••42" (DDD + 2 últimos dígitos) p/ suporte/ops.
--   * status      = 'consumed' (trial usado) | 'exempt' (whitelist interna do time).
--   * slot        = clone que consumiu — referência FRACA (SEM FK, SEM CASCADE):
--     o ledger sobrevive a DELETE do clone (deletar+recriar clone NÃO reseta trial).
--
-- flow_clones.trial_status — estado do trial do CLONE (aditivo, default preserva
-- comportamento de todos os clones existentes — Cirilo/matrizes ficam 'none'):
--   * none     = clone manual/legado; o hook de pareamento NUNCA mexe nele.
--   * awaiting = nasceu do signup self-service; trial arma no 1º WORKING da sessão.
--   * active   = trial iniciado (ledger consumido + client_billing.next_due_date=D+10).
--   * blocked  = pareou número que já consumiu trial — bot silenciado (flow_enabled).
--   * exempt   = número da whitelist interna pareado — segue sem consumir trial.
--
-- ISOLAMENTO: slot segue sendo a tenant key (padrão ADR 0007/0016). Aditivo, sem RLS
-- nova (dívida P0 separada — esta migration não piora a postura).
--
-- Idempotente: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--
-- Rollback (reversível — NUNCA no mesmo release):
--   -- ALTER TABLE flow_clones DROP COLUMN IF EXISTS trial_status;
--   -- DROP TABLE IF EXISTS trial_ledger;
--   -- (CUIDADO: dropar trial_ledger apaga o histórico anti-fraude — exportar antes.)

BEGIN;

CREATE TABLE IF NOT EXISTS trial_ledger (
  id           BIGSERIAL PRIMARY KEY,
  phone_hmac   TEXT NOT NULL UNIQUE,          -- HMAC-SHA256(pepper, E.164 canônico)
  phone_hint   VARCHAR(24),                   -- ex: "+55 31 •••••-••42" (suporte/ops)
  status       VARCHAR(16) NOT NULL DEFAULT 'consumed'
               CHECK (status IN ('consumed', 'exempt')),  -- exempt = whitelist interna
  slot         VARCHAR(80),                   -- clone que consumiu (referência FRACA, sem FK cascade)
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes        TEXT                           -- ex: "override Bruno: número reciclado"
);

-- Lookup operacional por slot (troca de número conta 2 consumos por trial).
CREATE INDEX IF NOT EXISTS idx_trial_ledger_slot ON trial_ledger (slot);

-- Estado do trial por clone. Default 'none' = zero mudança para clones existentes.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS trial_status VARCHAR(16) NOT NULL DEFAULT 'none'
    CHECK (trial_status IN ('none', 'awaiting', 'active', 'blocked', 'exempt'));

COMMIT;
