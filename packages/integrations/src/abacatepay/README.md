# AbacatePay (pagamento PIX) — F1

Cliente + servico de geracao idempotente de cobranca PIX. ADR 0013, Fase 1 (fundacao).

## O que tem nesta fase (F1)

- `client.ts` — `AbacatePayClient` (config injetada `{ apiKey, baseUrl }`). Metodos:
  - `createPixCharge({ slot, cycle, amountCents, description, expiresInSec })` → `POST /v2/transparents/create`. Valores em **CENTAVOS**. Retorna `{ id, brCode, brCodeBase64, status, expiresAt, platformFee }`.
  - `getChargeStatus(chargeId)` → `GET /v2/transparents/check?id={id}`. Poll de status (reconciliacao na F2).
- `service.ts` — `ensurePixChargeForCycle(client, { slot, cycle, amountCents })`. Idempotente por `(slot, cycle)` (UNIQUE no banco + "cria se nao existe"). Persiste em `billing_charges`.
- Migration `041_billing_charges.sql` (`packages/db/migrations`).
- Persistencia: `@startap/db` → `billingCharges.*` (`packages/db/src/queries/billing-charges.ts`).

A key vai **so** no header `Authorization: Bearer`, nunca em log. Ambiente Dev/Prod e definido **pela CHAVE**, nao pela URL.

## Config: opcional no boot, exigida no uso

`ABACATEPAY_API_KEY` e **OPCIONAL** no boot de `apps/api` e `apps/worker` (Zod `.optional()`).
Pagamento e feature **dormente** (sem webhook/cron ativos em prod) — torna-la obrigatoria no
boot acoplou o uptime dos bots a uma config nao usada e causou o incidente P0 de
**2026-06-09** (api/worker em loop de restart, bots fora ~6min; postmortem
`docs/startap/postmortems/2026-06-09-api-worker-loop-abacatepay-env.md`).

A exigencia vive no **ponto de uso**: `new AbacatePayClient({ apiKey })` lanca
`AbacatePayNotConfiguredError` (erro tipado, sem vazar segredo) se a chave faltar — falha
alta e explicita **so quando a feature roda**, nunca no boot. Quando o pagamento for
ATIVADO, basta preencher a env. Principio: *segredo de feature inativa = opcional no boot,
validado no uso; segredo de feature ativa = obrigatorio.*

## F2 — Webhook PIX + auto-reativacao (NESTE pacote: primitivas; rota em `apps/api`)

- `webhook.ts` (logica pura, testavel): `verifyWebhookSecret` (query secret, timing-safe, C6), `verifyWebhookSignature` (HMAC-SHA256 base64 sobre o **RAW BODY**, C3/C6), `redactWebhookPayload` (remove CPF/email/telefone/brCode antes de persistir, C5), `parseWebhookEvent` (extrai `eventId`/`status`/`abacateChargeId`/`paidAmount`).
- Rota `POST /webhooks/abacatepay` em **`apps/api/src/routes/webhook-abacatepay.ts`** (C10 — server-to-server, NAO no portal-api). Raw body **escopado** via content-type parser do proprio plugin (C3). Pipeline: 503 sem segredos (C9) → rate-limit (C6) → query secret → HMAC raw → so entao banco.
- Processamento transacional em **`@startap/db` `billingWebhookEvents.applyPaidWebhook`** (`packages/db/src/queries/billing-webhook-events.ts`): dedupe por `event_id` (C4), `FOR UPDATE` na cobranca (C4 race), reconciliacao de valor vs snapshot (C2), avanco de vencimento, auto-resume **so se `suspended_kind='billing'`** (C1).
- Migration `042_billing_webhook_events.sql`: tabela `billing_webhook_events` (dedupe, payload redigido) + coluna `flow_clones.suspended_kind`.
- Config (opcional no boot, C9): `ABACATEPAY_WEBHOOK_QUERY_SECRET`, `ABACATEPAY_WEBHOOK_SECRET` em `apps/api/src/config.schema.ts`.

## Outbox da chamada ao gateway (SCRUM-173)

Antes: o INSERT da linha `pending` e o `POST /v2/transparents/create` rodavam na MESMA
transação (advisory lock). Um timeout na resposta (gateway já tinha CONFIRMADO) abortava a
transação, desfazia o INSERT, e o retry criava uma SEGUNDA cobrança real — sem rastro local
do que aconteceu (201 linhas em prod, ZERO órfãs, era o SINTOMA da perda, não saúde).

Agora `service.ts` usa `callGatewayWithOutbox`: (1) marca `billing_charges.gateway_call_state
= 'calling'` numa transação PRÓPRIA que COMMITA antes do POST; (2) chama o gateway FORA de
transação; (3) reabre o lock numa transação NOVA pra persistir o resultado e fechar em
`'done'`. Um retry que encontre `'calling'` recente (dentro de `GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS`,
30s) recebe `PixChargeGatewayInFlightError` — NÃO chama o gateway de novo. Migration 081.

**Limitação aceita:** a AbacatePay não expõe busca por `externalId` (só create/check-by-id/
simulate). Depois do timeout de ambiguidade não há como confirmar se a tentativa anterior
criou de fato uma cobrança — o pior caso residual é um PIX `pending` órfão no gateway (sem
duplo-crédito: o webhook casa por `external_id`, SCRUM-139, e nunca reescreve `paid`).

## O que NAO tem aqui (fases seguintes)

- Endpoint do portal (`GET /portal/billing/current`) + UI → **F3**.
- Cron mensal de geracao + reconciliacao → **F4** (`apps/worker`).

## Smoke test no Dev (manual — Bruno/PM com a chave Dev)

> A chave Dev nao fica no repo. Rode local com a key no `.env`.

1. **Setar a chave Dev** no `.env` (api + worker):
   ```
   ABACATEPAY_API_KEY=<chave_dev>
   ABACATEPAY_BASE_URL=https://api.abacatepay.com
   ```
2. **Aplicar a migration** (cria `billing_charges`):
   ```
   bash scripts/migrate.sh
   ```
   Confirmar: `psql ... -c "\d billing_charges"` mostra a tabela + `ux_billing_charges_slot_cycle`.
3. **Gerar uma cobranca** via REPL/script Node (ainda nao ha endpoint — F3/F4):
   ```ts
   import { AbacatePayClient, ensurePixChargeForCycle } from '@startap/integrations/abacatepay';
   // Sem a key, o construtor lanca AbacatePayNotConfiguredError (esperado fora do smoke).
   const client = new AbacatePayClient({
     apiKey: process.env.ABACATEPAY_API_KEY,
     baseUrl: process.env.ABACATEPAY_BASE_URL,
   });
   const { charge, created } = await ensurePixChargeForCycle(client, {
     slot: 'barbearia-cirilo', cycle: '2026-06', amountCents: 19900,
   });
   console.log({ created, id: charge.abacate_charge_id });
   ```
   Confirmar no banco:
   ```
   psql ... -c "SELECT slot, cycle, abacate_charge_id, amount_cents, status, br_code IS NOT NULL AS tem_brcode FROM billing_charges WHERE slot='barbearia-cirilo';"
   ```
   `abacate_charge_id` deve ser `pix_char_*`, `br_code`/`br_code_base64` preenchidos, `status='pending'`.
4. **Idempotencia**: rodar o mesmo `ensurePixChargeForCycle` de novo. `created` deve vir `false` e **nenhuma** linha nova no banco (UNIQUE `slot,cycle`).
5. **Forcar pagamento (Dev)** sem PIX real:
   ```
   curl -X POST "https://api.abacatepay.com/v2/transparents/simulate-payment?id=<pix_char_id>" \
     -H "Authorization: Bearer $ABACATEPAY_API_KEY"
   ```
6. **Confirmar status** via `getChargeStatus`:
   ```ts
   console.log(await client.getChargeStatus('<pix_char_id>')); // status: 'paid', paidAmountCents
   ```
   > Na F1 o status PAID **nao** avanca vencimento nem reativa fluxo — isso e o handler de webhook da F2 (controles C1–C4). Aqui so confirmamos que a leitura de status funciona.

## Smoke test do WEBHOOK no Dev (F2 — manual, Bruno/PM com a chave Dev)

> Exercita o webhook real **sem PIX de verdade** via `simulate-payment`. Pre-req: F1 ja roda
> (cobranca gerada). A api precisa estar no ar com os segredos do webhook configurados.

1. **Setar os segredos do webhook** no `.env` da api (alem da `ABACATEPAY_API_KEY` da F1):
   ```
   ABACATEPAY_WEBHOOK_QUERY_SECRET=<qualquer_segredo_forte>
   ABACATEPAY_WEBHOOK_SECRET=<chave_compartilhada_do_webhook_no_painel_abacatepay>
   ```
   No painel da AbacatePay, cadastrar a URL do webhook como
   `https://<host>/webhooks/abacatepay?webhookSecret=<ABACATEPAY_WEBHOOK_QUERY_SECRET>`
   e usar a mesma `ABACATEPAY_WEBHOOK_SECRET` que assina o header `X-Webhook-Signature`.
2. **Aplicar a migration** (cria `billing_webhook_events` + `flow_clones.suspended_kind`):
   ```
   bash scripts/migrate.sh
   ```
   Confirmar: `psql ... -c "\d billing_webhook_events"` e `\d flow_clones` (coluna `suspended_kind`).
3. **(opcional) Suspender o slot por billing** pelo painel de gestao (categoria
   "Inadimplencia / cobranca") pra exercitar o auto-resume — grava `suspended_kind='billing'`.
4. **Gerar a cobranca** (F1) e **simular o pagamento**:
   ```
   curl -X POST "https://api.abacatepay.com/v2/transparents/simulate-payment?id=<pix_char_id>" \
     -H "Authorization: Bearer $ABACATEPAY_API_KEY"
   ```
   A AbacatePay dispara o webhook `transparent.completed` (status `PAID`) pra nossa rota.
5. **Conferir o efeito** no banco:
   ```
   psql ... -c "SELECT status, paid_amount_cents, paid_at FROM billing_charges WHERE abacate_charge_id='<pix_char_id>';"   -- status='paid'
   psql ... -c "SELECT to_char(next_due_date,'YYYY-MM-DD'), status FROM client_billing WHERE slot='<slot>';"               -- vencimento +1 mes
   psql ... -c "SELECT flow_enabled, suspended_kind FROM flow_clones WHERE slot='<slot>';"                                  -- flow_enabled=true se era billing
   psql ... -c "SELECT event_id, event, processed_at, payload FROM billing_webhook_events ORDER BY received_at DESC LIMIT 1;" -- payload SEM CPF/email/telefone/brCode (C5)
   ```
6. **Replay (dedupe C4)**: reenviar o **mesmo** evento (mesmo `event_id`) — `billing_webhook_events`
   nao ganha linha nova e nada e reprocessado (resposta `200 {status:'duplicate'}`).
7. **Underpaid (C2)**: simular pagamento de valor abaixo do `amount_cents` da cobranca — a cobranca
   vira `paid` MAS `next_due_date` **nao** avanca e `flow_enabled` **nao** muda; log de alerta
   `billing-underpaid` pro Bruno.

## Endpoints confirmados

- Criar cobranca PIX: `POST /v2/transparents/create` (body `{ method:'PIX', data:{ amount, description, expiresIn, externalId, metadata } }`). Fonte: ADR 0013 (docs.abacatepay.com).
- Checar status: `GET /v2/transparents/check?id={id}`.
- Simular pagamento (Dev): `POST /v2/transparents/simulate-payment?id={id}`.
- Webhook (F2): `POST /webhooks/abacatepay?webhookSecret={query}` + header `X-Webhook-Signature` (HMAC-SHA256 base64 do raw body). Evento `transparent.completed` com `status:PAID`.
