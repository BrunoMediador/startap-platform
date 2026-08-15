# ADR 0039 — Outbox de chamada ao gateway PIX (AbacatePay)

- **Status:** Aceito (implementado)
- **Data:** 2026-08-15
- **Autor:** backend-senior, revisado por security + QA, desenho corrigido pelo arquiteto
- **Jira:** SCRUM-173
- **Relacionados:** ADR 0013 (fundação AbacatePay), ADR 0014 (modelo por data de
  vencimento), ADR 0037 (transição transacional de pagamento), SCRUM-139 (fallback por
  `external_id` no webhook), SCRUM-141 (`superseded_charge_ids`)

## Contexto

`ensurePixChargeForCycle`/`ensurePixChargeForSlot` (`packages/integrations/src/abacatepay/
service.ts`) faziam o `INSERT` da linha `pending` e o `POST` ao AbacatePay na **mesma
transação** do advisory lock (`withBillingSlotLock`). Se o gateway confirmava a cobrança mas
a resposta se perdia (timeout de rede), o `throw` abortava a transação, desfazia o `INSERT`,
e o retry seguinte não via rastro nenhum — criava uma **segunda cobrança real** no gateway.
Medido em produção: 201 linhas em `billing_charges`, **zero** com `abacate_charge_id NULL` —
a ausência de linhas órfãs era o sintoma da perda, não prova de saúde.

**Restrição de fornecedor** (confirmada em `client.ts` e no README do pacote, seção
"Endpoints confirmados"): a AbacatePay só expõe `POST /v2/transparents/create`, `GET
/v2/transparents/check?id=`, e `POST /v2/transparents/simulate-payment?id=` (Dev-only). **Não
há busca por `externalId`.** Isso elimina a opção "depois de um timeout, consulta o gateway
pra confirmar se a cobrança anterior foi criada" — não existe API pra isso.

## Decisão

### D1 — Outbox: a intenção de chamar o gateway é persistida ANTES do POST, em transação própria

`billing_charges` ganha `gateway_call_state` (`'idle'|'calling'|'done'`, migration 081) e
`gateway_call_started_at`. `callGatewayWithOutbox` faz: (1) reivindica a chamada numa
transação que **commita antes do POST**; (2) chama o gateway fora de transação; (3) reabre o
lock numa transação nova pra persistir o resultado e fechar em `'done'`. Um timeout no passo
2 não desfaz o passo 1 — o rastro local sobrevive.

### D2 — Claim atômico, não check-then-act (corrige TOCTOU real — achado do security)

A primeira versão avaliava "posso chamar?" (`outboxCallAllowed`, leitura em JS) e só depois
fazia o `UPDATE` (`markGatewayCalling`) — entre as duas operações, e entre processos
distintos (portal-api e worker rodam em processos separados; o single-flight local é um
`Map` in-process que não os coordena), o slot fica sem proteção nenhuma. `claimGatewayCall`
substitui isso por um **`UPDATE` condicional de uma única statement**: o `WHERE` decide
atomicamente se a linha está livre, o `SET` só aplica se a condição bateu. Postgres
serializa por row-level lock implícito do próprio `UPDATE` — não pelo advisory lock (que já
foi liberado nesse ponto). Duas cláusulas obrigatórias no `WHERE`: `gateway_call_started_at
IS NULL` (senão uma linha `'calling'` sem timestamp trava para sempre) e `status <> 'paid'`
(nunca rechama o gateway para uma cobrança já paga).

### D3 — O relógio de decisão é o do BANCO, não o do processo (P2 do QA)

A comparação "passou do timeout de ambiguidade" roda com `NOW()` **dentro do SQL**, não com
`Date` do Node. Clock skew entre instâncias (portal-api e worker podem rodar em hosts
distintos) alteraria a janela percebida de forma silenciosa se a comparação fosse em JS.
`NOW()` do Postgres é o único relógio compartilhado por todos os processos que disputam o
claim. `GATEWAY_CALL_AMBIGUOUS_TIMEOUT_MS` (30s, constante compilada) continua sendo a fonte
única do número — passada como **parâmetro** pro SQL, nunca hardcoded no statement.

### D4 — Leitura de PRODUTO vs leitura de GERAÇÃO (achado do security, F1)

Uma linha presa em `'calling'` (outbox em voo ou órfão — sem `br_code`, sem QR pagável) casa
no filtro antigo de "cobrança ativa" e seria devolvida ao portal como "pendente" sem QR: o
cliente veria um estado sem saída e, com `BILLING_OVERDUE_SILENCE` + `GRACE_DAYS=3`, o bot
dele calaria no 4º dia sem ele conseguir pagar — regressão líquida pior que a duplicação
rara que o outbox evita. A partir daqui, duas funções de leitura distintas com propósitos
diferentes:

| Função | Filtro | Consumidor |
|---|---|---|
| `getActivePendingCharge` | `status='pending' AND br_code IS NOT NULL AND (expires_at IS NULL OR expires_at > now)` | Portal (`GET /portal/mensalidade`) — só mostra cobrança **efetivamente pagável** |
| `getResumableChargeForSlot` | `status='pending' AND (expires_at IS NULL OR expires_at > now)` (sem exigir `br_code`) | Geração (`ensurePixChargeForSlot`, fase 1, sob o lock) — **reaproveita** a linha órfã (reissue) em vez de inserir uma nova |

`chargeView` (`portal-billing.ts`) tem a mesma proteção como defesa em profundidade: uma
linha `pending` sem `br_code` vira `charge: null` para o cliente, nunca `is_expired: true`
(a linha não está expirada, só ainda não pagável — sinalizar "gere de novo" seria incorreto
quando o outbox pode completar sozinho no próximo request). Cobre os dois modelos (ADR
0014 ON e o legado por ciclo, OFF).

## Risco residual aceito

Depois do timeout de ambiguidade, uma nova tentativa é liberada mesmo sem confirmar se a
anterior de fato criou uma cobrança no gateway (não há endpoint de busca por `externalId`
— D1). O pior caso é um PIX `pending` **órfão** no gateway, pagável mas nunca referenciado
por nenhuma linha ativa em `billing_charges`. **Nunca há duplo-crédito**: o webhook casa por
`external_id` (SCRUM-139) e nunca reescreve uma cobrança já `'paid'`. Se o cliente pagar os
dois QR codes gerados por essa corrida rara, o segundo pagamento cai no outcome `orphan` de
`applyPaidWebhook` — instrumentado em `log.warn` com `paidAmountCents` (sem PII, sem
`br_code`) para permitir revisão manual, já que esse outcome antes só era registrado em
`info` e podia passar despercebido se o canal de alertas estiver indisponível.

## Alternativas descartadas

- **Endpoint de busca por `externalId` na AbacatePay**: não existe.
- **Tabela de outbox separada (`billing_gateway_outbox`)**: adicionaria uma segunda fonte de
  verdade para sincronizar com `billing_charges`; as duas colunas na própria tabela mantêm
  o estado onde ele já é lido/escrito, sem JOIN novo no caminho quente.
- **Redis para o claim distribuído**: Redis não está no caminho de billing hoje (ADR 0019
  propõe isso para dedup de mensagem WhatsApp, não para PIX); Postgres já é a fonte de
  verdade transacional de `billing_charges`, e o claim atômico via `UPDATE` condicional não
  precisa de infraestrutura nova.

## Consequências

- Migration 081 (aditiva, `DEFAULT 'idle'`, retrocompatível — código antigo em janela de
  deploy mista continua funcionando, a coluna nova simplesmente não é lida por ele).
- `service.ts` reestruturado em 3 transações curtas por chamada ao gateway, em vez de 1
  longa — mais chamadas ao pool, mas cada uma é rápida (sem segurar conexão durante o POST
  de até 15s).
- Sobe **ligado, sem flag** (decisão prévia do Bruno) — o caminho novo é o único caminho.
