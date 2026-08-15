-- Migration 081: billing_charges.gateway_call_state — fecha a janela de cobranca PIX
-- duplicada por timeout ambiguo (SCRUM-173).
--
-- CAUSA RAIZ (medida em prod, 201 linhas em billing_charges, ZERO com abacate_charge_id
-- NULL): em ensurePixChargeForCycle/ensurePixChargeForSlot, o INSERT da linha 'pending' e
-- o POST ao gateway rodam na MESMA transacao (advisory lock xact). Se o gateway CONFIRMA a
-- cobranca mas a resposta se perde (timeout, rede cai depois do 200), o throw ABORTA A
-- TRANSACAO -> o INSERT e desfeito -> nao sobra rastro local. O retry seguinte nao ve
-- nenhuma linha pending e cria uma SEGUNDA cobranca real no gateway. A ausencia de linhas
-- orfas no banco e o SINTOMA da perda, nao prova de saude.
--
-- O QUE ESTA COLUNA FAZ: registra a INTENCAO de chamar o gateway ANTES do POST, numa
-- transacao que COMMITA antes do efeito externo (ver packages/integrations/src/abacatepay/
-- service.ts). Se o processo morrer/perder a resposta entre o POST e o attach, a linha
-- fica com gateway_call_state='calling' e gateway_call_started_at preenchido — rastro
-- LOCAL sobrevive ao rollback porque nao esta mais na mesma transacao do POST.
--
-- O retry seguinte, ao encontrar 'calling' com gateway_call_started_at RECENTE (dentro do
-- timeout de ambiguidade), NAO chama o gateway de novo — devolve billing_busy (503,
-- Retry-After) igual ao advisory lock ocupado. So depois do timeout de seguranca passar
-- (a chamada anterior esta definitivamente morta, nunca mais vai responder) o codigo
-- libera nova tentativa. Isso reduz a janela de duplicacao ao caso raro "timeout ambiguo
-- E DEPOIS o processo trava/cai" sem nunca eliminar 100% (a AbacatePay nao expoe busca por
-- externalId — so create/check-by-id/simulate; ver packages/integrations/src/abacatepay/
-- README.md secao "Endpoints confirmados"). Documentado como limitacao aceita no PR.
--
-- RETROCOMPATIBILIDADE (janela de deploy com codigo velho + schema novo): DEFAULT 'idle'
-- cobre TODA linha existente e qualquer INSERT feito pelo codigo ANTIGO (que nao referencia
-- a coluna nova) — o codigo velho continua fazendo INSERT sem gateway_call_state, a coluna
-- assume o default e o codigo novo, quando substituir o velho, interpreta 'idle' como
-- "nenhuma chamada em curso" (comportamento correto, nunca bloqueia). gateway_call_started_at
-- NULL e tratado como "sem timestamp -> nao ambiguo" pelo codigo novo. Nenhuma linha
-- existente muda de significado.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
--
-- Rollback (reversivel — nunca dropar na mesma release que cria):
--   ALTER TABLE billing_charges DROP COLUMN IF EXISTS gateway_call_state;
--   ALTER TABLE billing_charges DROP COLUMN IF EXISTS gateway_call_started_at;

BEGIN;

ALTER TABLE billing_charges
  ADD COLUMN IF NOT EXISTS gateway_call_state TEXT NOT NULL DEFAULT 'idle';

ALTER TABLE billing_charges
  ADD COLUMN IF NOT EXISTS gateway_call_started_at TIMESTAMPTZ;

-- Trava de dominio (idempotente, sem DROP): so os 3 estados do maquinario. IF NOT EXISTS
-- evita erro em re-run sem precisar de DROP CONSTRAINT.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_charges_gateway_call_state_check'
  ) THEN
    ALTER TABLE billing_charges
      ADD CONSTRAINT billing_charges_gateway_call_state_check
      CHECK (gateway_call_state IN ('idle', 'calling', 'done'));
  END IF;
END $$;

COMMIT;
