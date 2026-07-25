-- Migration 078: billing_charges.superseded_charge_ids — QRs abandonados pela reemissao
-- antecipada (SCRUM-141).
--
-- CONTEXTO (ADR 0014 + SCRUM-124/139): a reemissao ANTECIPADA (BILLING_REISSUE_AHEAD_MIN,
-- default 120min) reemite a MESMA linha ANTES do PIX vencer e SOBRESCREVE o abacate_charge_id
-- com o novo QR. O QR ANTIGO segue PAGAVEL no gateway por mais um tempo. Se o cliente pagar
-- o QR VELHO:
--   - webhook RECEBIDO  -> ja resolvido: fallback por external_id no webhook (SCRUM-139/#497)
--                          casa a linha 'pending' mais recente e credita, sem orfao.
--   - webhook PERDIDO    -> BURACO (este card): a reconciliacao do cron F4 so consulta o
--                          abacate_charge_id VIGENTE (o QR novo, ainda pending) -> nunca
--                          descobre que o QR velho foi pago. Dinheiro entra, cliente nao e
--                          creditado, bot continua mudo.
--
-- O QUE ESTA COLUNA FAZ: guarda o HISTORICO de abacate_charge_id abandonados por reemissao
-- (append no reissueGatewayData*/reissueGatewayDataById). A reconciliacao do cron F4 passa a
-- pollar TAMBEM esses ids no gateway (getChargeStatus, endpoint confirmado) e, se algum sair
-- PAID, credita via applyPaidWebhook usando o external_id como fallback (mesma trava
-- anti-duplo-credito do webhook: casa 'pending' + dedupe por event_id 'recon:<id>'). Fecha o
-- vetor do webhook PERDIDO sem precisar de um endpoint de LISTAGEM do gateway (que a
-- AbacatePay /v2/transparents/* nao expoe de forma confirmada).
--
-- TEXT[] NOT NULL DEFAULT '{}': array vazio pra toda linha existente e nova; nunca NULL, o
-- codigo faz array_append(coalesce(...,'{}'), ...) mesmo assim (defensivo). Aditiva:
-- nao toca nenhuma coluna/linha existente; segura com a flag OFF (a coluna simplesmente
-- fica '{}' e a reconciliacao nova nao encontra nada pra pollar).
--
-- ISOLAMENTO / RLS: `slot` segue a tenant key de billing_charges — esta migration nao piora
-- a postura de RLS (so adiciona uma coluna de historico de ids do gateway, sem PII).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
--
-- Rollback (reversivel — nunca dropar na mesma release que cria):
--   ALTER TABLE billing_charges DROP COLUMN IF EXISTS superseded_charge_ids;

BEGIN;

ALTER TABLE billing_charges
  ADD COLUMN IF NOT EXISTS superseded_charge_ids TEXT[] NOT NULL DEFAULT '{}';

COMMIT;
