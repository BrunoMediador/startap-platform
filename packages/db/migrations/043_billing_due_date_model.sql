-- Migration 043: billing por DATA DE VENCIMENTO — afrouxa a identidade da cobranca.
--
-- ADR 0014 (Cobranca PIX controlada por data de vencimento). Fase 1 (schema).
--
-- O QUE MUDA (aditivo, reversivel, SEM downtime; seguro com a flag de codigo
-- BILLING_DUE_DATE_MODEL=false — nada no comportamento atual depende destas mudancas):
--
--   1) Remove o UNIQUE(slot, cycle) (ux_billing_charges_slot_cycle).
--      Motivo: o UNIQUE impedia (a) 2 cobrancas no mesmo mes-calendario (re-cobranca) e
--      (b) desacoplar a cobranca do calendario. No modelo novo a invariante "no maximo 1
--      pending valida por slot" passa a ser de APLICACAO (advisory lock + recheck na
--      transacao de geracao — ver ensurePixChargeForSlot), nao de banco.
--      Os indices de LOOKUP (idx_billing_charges_slot/status/external_id) ficam INTACTOS.
--
--   2) cycle: CHAR(7) -> VARCHAR(10). Motivo: o campo passa a guardar o PERIODO DE
--      VENCIMENTO alvo no formato 'YYYY-MM-DD' (a next_due_date vigente na geracao), nao
--      mais 'YYYY-MM'. VARCHAR(10) cabe os dois formatos. Linhas antigas com 'YYYY-MM'
--      (CHAR(7), padding de espaco a direita) continuam validas — nao sao migradas; sao
--      apenas historico que o webhook nunca reabre (ele casa por abacate_charge_id).
--      NOTA: ao virar VARCHAR, o padding de espaco do CHAR(7) some na conversao do PG
--      (VARCHAR nao faz blank-pad), entao valores historicos ficam '2026-06' limpos.
--
-- O QUE NAO MUDA: nenhuma coluna dropada; nenhuma tabela nova; client_billing,
-- suspended_kind/auto-resume e billing_webhook_events permanecem intactos.
--
-- ISOLAMENTO / RLS (divida P0): `slot` segue a TENANT KEY de billing_charges. Esta
-- migration NAO piora a postura de RLS (so afrouxa um indice de unicidade e amplia um
-- tipo de coluna).
--
-- Idempotente: DROP INDEX IF EXISTS + ALTER ... TYPE (no-op se ja for VARCHAR(10)).
--
-- Rollback (reversivel — forward-fix preferivel):
--   -- (1) Recriar o UNIQUE so e seguro se NAO houver duplicatas de (slot, cycle). No
--   --     modelo novo havera 2+ linhas por (slot, cycle) (re-cobranca/reemissao), entao
--   --     este passo PODE falhar — e esperado. Rode so se o modelo novo nunca gerou dados:
--   --       CREATE UNIQUE INDEX ux_billing_charges_slot_cycle ON billing_charges (slot, cycle);
--   -- (2) Reverter o tipo da coluna TRUNCARIA 'YYYY-MM-DD' -> nao reverter:
--   --       ALTER TABLE billing_charges ALTER COLUMN cycle TYPE CHAR(7);  -- PERIGOSO: trunca
--   --     Manter VARCHAR(10) nao perde nada e e o rollback REAL recomendado.
--   -- Resumo: reverter = desligar a flag de codigo (BILLING_DUE_DATE_MODEL=false). O schema
--   --         em VARCHAR(10) sem UNIQUE e compativel com o modelo antigo (cycle='YYYY-MM').

BEGIN;

-- (1) Remove a unicidade de banco (a invariante "1 pending/slot" vira transacional).
DROP INDEX IF EXISTS ux_billing_charges_slot_cycle;

-- (2) cycle passa a caber 'YYYY-MM-DD' (periodo de vencimento). Aditivo: CHAR(7) antigos
-- continuam validos como VARCHAR. USING explicito + TRIM remove o blank-pad do CHAR.
ALTER TABLE billing_charges
  ALTER COLUMN cycle TYPE VARCHAR(10) USING TRIM(TRAILING ' ' FROM cycle::text);

COMMIT;
