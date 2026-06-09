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

## O que NAO tem aqui (fases seguintes)

- Webhook (`POST /webhooks/abacatepay`), validacao HMAC + query secret, dedupe, auto-resume → **F2** (`apps/api`).
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
   const client = new AbacatePayClient({
     apiKey: process.env.ABACATEPAY_API_KEY!,
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

## Endpoints confirmados

- Criar cobranca PIX: `POST /v2/transparents/create` (body `{ method:'PIX', data:{ amount, description, expiresIn, externalId, metadata } }`). Fonte: ADR 0013 (docs.abacatepay.com).
- Checar status: `GET /v2/transparents/check?id={id}`.
- Simular pagamento (Dev): `POST /v2/transparents/simulate-payment?id={id}`.
