# ADR 0025 — Pacotes de serviço (créditos pré-pagos) com ledger append-only

- **Status:** ACEITO (em produção; retroativamente documentado — o código já cita "ADR 0025" desde os PRs #320/#321)
- **Data:** 2026-06-23 (doc); decisão original ~#320
- **Autor:** 02-backend-senior
- **Aprovado por:** Bruno
- **Relacionados:** ADR 0006 (Google Calendar por clone — dono do horário), ADR 0007 (isolamento de memória por clone — `slot`), ADR 0018 (`tenant_id` por cliente — isolamento), ADR 0019 (idempotência/lock Redis), ADR 0023/0024 (`clone_colaboradores`, agenda por profissional), ADR 0026 (`atendimentos` — faturamento; domínio SEPARADO).

---

## Contexto

Barbearias/salões vendem **pacotes pré-pagos**: "5 cortes por R$ X", "pé+mão 4 sessões", etc. O cliente paga uma vez e vai descontando sessão a sessão conforme agenda. O sistema precisava de:

1. um **catálogo** de pacotes que o dono define (template: nome, serviços cobertos, nº de sessões, validade, preço, escopo casa/colaborador);
2. uma **instância** vendida a um cliente final (saldo, validade);
3. **dedução automática** de uma sessão quando o bot agenda um serviço coberto;
4. **isolamento por cliente** (P0 — ADR 0018) e **LGPD** (número do cliente final nunca cru).

Restrições que moldam a decisão:

- **Sem ORM.** Migrations SQL raw idempotentes e aditivas (`scripts/migrate.sh`).
- **Isolamento (ADR 0018):** toda linha carrega `slot` + `tenant_id UUID`.
- **LGPD:** o número do cliente final entra só como **HMAC** (`PACKAGE_PHONE_PEPPER`, pepper PRÓPRIO de pacotes — distinto do trial, nunca rotaciona) + `cliente_phone_hint` (DDD + 2 últimos) pro suporte.
- **O LLM nunca raciocina saldo.** Cobertura/saldo/validade são decididos **server-side**; o bot lê linha pronta.

---

## Decisão

Três tabelas (migrations 054/055/056):

- **`service_packages`** — TEMPLATE do pacote (definido pelo dono). Colunas-chave: `nome`, `servicos_cobertos` (jsonb), `total_sessoes`, `validade_dias` XOR `data_validade_fixa`, `preco_cents`, `colaborador_id` (NULL = casa; preenchido = só com aquele profissional), `ativo`.
- **`client_package_credits`** — INSTÂNCIA vendida a um cliente final. `cliente_phone_hmac` + `cliente_phone_hint`, `sessoes_total`, `sessoes_restantes` (CACHE), `data_expiracao`, `status` (`active|expired|exhausted|cancelled`). `CHECK (sessoes_restantes BETWEEN 0 AND sessoes_total)`.
- **`package_redemptions`** — **LEDGER append-only imutável = FONTE DA VERDADE do saldo.** Cada linha é um movimento (`delta`) ligado a um `gcal_event_id`, com `reason`. `UNIQUE(gcal_event_id, reason)` = idempotência por evento.

### Invariantes centrais

1. **Saldo = `sessoes_total + SUM(delta)` do ledger.** `sessoes_restantes` é só cache, **reconstruído do ledger na MESMA transação** (`rebuildCreditCacheTx`), clampado `[0..sessoes_total]`. **Nunca** UPDATE aritmético solto no cache.
2. **Ledger é append-only.** Nunca se edita nem deleta uma redemption. Toda mudança de saldo é um INSERT novo.
3. **Idempotência por `UNIQUE(gcal_event_id, reason)`** + `ON CONFLICT DO NOTHING`: o mesmo evento nunca desconta 2x nem estorna 2x.
4. **Status derivado** server-side: `cancelled` > `expirado` (por data) > `saldo<=0` (ESGOTADO) > ATIVO. `rebuildCreditCacheTx` re-deriva `active`/`exhausted` do saldo e **preserva `cancelled`** (decisão explícita do operador).
5. **Isolamento:** escopo por `slot` (+`tenant_id` como defesa em profundidade quando o caller o fornece, P3 do review do #320).

### Blocos de implementação

- **BLOCO 2a (leitura):** `listActiveTemplates` / `listClientCredits` / `listActiveClientCredits` + `package-context.ts` (bloco de prompt `[SEU PACOTE]`, read-only). Inclui `preco_cents` para o bot informar "R$ X,XX" quando perguntado — **INFORMATIVO** (caixa do barbeiro), **§5 abaixo**.
- **BLOCO 2b (dedução/estorno pelo BOT):** `redeemForBooking` (delta=-1, `reason='redeem'`) sob action-lock (ADR 0019), com guarda anti-over-consumption (só grava -1 se saldo do ledger > 0 na mesma tx, sob `FOR UPDATE`). `refundForBooking` (delta=+1, `reason='refund'`) = estorno MANUAL (o bot NUNCA cancela — escala pro dono; Missão 023 W5).
- **BLOCO 2c (lifecycle pós-venda pelo PAINEL — ESTE PR):** ver §"Nova invariante" abaixo.

---

## §4 — Cobertura e escopo

- Cobertura é casada por **nome normalizado** (`normalizeServiceName`: trim + lowercase + dobra de acento). Sem sinônimo/stemming (o dono cadastra o canônico).
- Precedência determinística de dedução (`escolherCreditoParaDeducao`): (1) colaborador-específico antes de casa; (2) menor validade (expira antes); (3) credit_id menor (mais antigo).
- Pacote sem serviços vinculados não cobre nada.

## §5 — Separação FISCAL (regra de design)

`preco_cents` do pacote e o saldo de sessões são o **caixa do barbeiro** (o negócio DELE). **NUNCA** se misturam com `client_billing` / AbacatePay / `billing_charges` / MRR — que é a **mensalidade B2B que o cliente paga PRA NÓS**. Tabelas, rotas e relatórios separados. Recarregar um pacote **não** emite cobrança nossa nem toca o billing B2B.

---

## Nova invariante (BLOCO 2c — lifecycle pós-venda) — ADENDO 2026-06-23

Até aqui, **só o BOT escrevia no ledger** (redeem/refund por `gcal_event_id`). Faltava todo o **pós-venda**: renovar/recarregar um pacote, mudar vencimento, reativar esgotado, estornar/cancelar. Decisão do Bruno: **renovação reusa o MESMO pacote** (soma sessões + muda vencimento no mesmo card; **1 card por cliente**), não cria um card novo.

**Decisão:** o **painel** agora **PODE escrever no ledger**, mas **SÓ** com:

- **`reason='recharge'`, `delta = +N` (N > 0)** — renovação/recarga. **Distinto** de `redeem` (-1) e `refund` (+1 casado a um evento real). Como recharge **não** está ligada a um agendamento, usa uma **chave sintética** como âncora de idempotência, gravada em `gcal_event_id` (NOT NULL): **`recharge:<creditId>:<idempotencyKey>`**. Duas recargas distintas = chaves distintas (somam); retry exato da MESMA recarga = mesma chave → `ON CONFLICT DO NOTHING` (não dupla-conta).

Operações do bloco 2c (em `packages.ts` + rotas no `painel-admin/server.js`):

| Operação | Ledger? | Como |
|---|---|---|
| **Recarregar / renovar** (`recargaCredit`) | SIM (`+N`, `recharge`) | numa tx: `FOR UPDATE` do crédito → INSERT recharge (idempotente) → `sessoes_total += N` → nova validade opcional → `rebuildCreditCacheTx` reativa `exhausted→active`. |
| **Reativar esgotado/expirado** | = recarga | a própria recarga: saldo>0 + validade futura ⇒ status volta a `active`. |
| **Reativar cancelado** (`reativarCredito`) | = recarga | limpa `status='cancelled'` ANTES (rebuild preserva cancelled), depois recarga. |
| **Mudar vencimento** (`mudarVencimento`) | NÃO | UPDATE `data_expiracao` escopado `slot`(+`tenant`); rebuild re-deriva status. |
| **Estornar** (`refundForBooking` / rota nova) | SIM (`+1`, `refund`) | devolve 1 sessão de um `gcal_event_id` que não vai acontecer (disparo manual). |
| **Cancelar crédito** (`cancelarCredito`) | NÃO | UPDATE `status='cancelled'`; ledger intacto; reversível via recarga `{reativar:true}`. |

### Por que isto NÃO dupla-conta

- `recharge` é `delta > 0` e tem `reason` próprio — o saldo `sessoes_total + SUM(delta)` continua exato. O CHECK `[0..sessoes_total]` segue válido porque **`sessoes_total` cresce junto** (não estouramos o teto).
- A idempotência por chave sintética garante que **retry de uma recarga não soma 2x** nem mexe na validade de novo.
- O ledger continua **append-only**: recarga é um INSERT novo, nunca edição.
- Estorno/cancelamento não inventam crédito: casam o `credit_id` ao redeem original / ao próprio crédito, escopados `slot`+`tenant`.

### Contrato dos endpoints (painel `gestao.startap.tech`)

Todos atrás de `requireAuth` + CSRF, escopados por clone (`:id` → `slot`+`tenant_id`), audit log estruturado sem PII.

- `POST /api/clones/:id/creditos/:creditId/recarregar` — body `{ sessoes (1..1000), data_expiracao?|adicionar_dias?, idempotency_key?, reativar? }`.
- `PATCH /api/clones/:id/creditos/:creditId` — body `{ data_expiracao } | { adicionar_dias }` (exatamente um). Só vencimento.
- `POST /api/clones/:id/creditos/:creditId/cancelar` — sem body. `status='cancelled'`.
- `POST /api/clones/:id/creditos/:creditId/estornar` — body `{ gcal_event_id }`. +1 sessão idempotente.

---

## Consequências

- **Positivas:** lifecycle de pacote completo (renovar/recarregar/reativar/estornar/cancelar) sem violar o ledger append-only nem a separação fiscal; 1 card por cliente (decisão do Bruno); idempotente; isolado por tenant.
- **Risco aceito (dívida 5):** o ciclo **cancelar+reagendar** no GCal gera um `gcal_event_id` NOVO — `UNIQUE(gcal_event_id,reason)` não liga o evento velho (descontado) ao novo (que descontaria de novo) ⇒ risco de baixar 2 sessões de 1 atendimento. Mitigação: estorno manual + `findSuspectDoubleRedeems` (relatório read-only pro ops). Sem auto-refund.
- **Tech debt:** ADR 0024 (agenda assistida) ainda só citado no código; o painel mirror de `packages.ts` precisa ser mantido em sync à mão (painel é JS standalone, sem build-time dep de `@startap/db`).
