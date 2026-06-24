# ADR 0027 — Atendimento derivado da agenda (sync por `event_id`, previsão × faturado)

- **Status:** ACEITO (Bruno aprovou as decisões simplificadoras desta sessão)
- **Data:** 2026-06-23
- **Autor:** 01-arquiteto
- **Aprovado por:** Bruno
- **Relacionados:** ADR 0026 (`atendimentos` como fonte da verdade do financeiro — **este ADR supersede em parte** o modelo de dados/Fase 2 daquele), ADR 0006 (Google Calendar por clone — dono do horário), ADR 0018 (`tenant_id` por cliente — isolamento), ADR 0023/0024 (`clone_colaboradores`, agenda por profissional), ADR 0025 (pacotes/`package_redemptions` — ledger por `gcal_event_id`, **fica SEPARADO e intocado**).

---

## Erratum 2026-06-23 — comissão do Faturado é LIVE-COMPUTE (não snapshot)

> Supersede a parte da **Decisão 3** que dizia "soma o `comissao_cents` congelado". A auditoria de billing achou 3 bugs de dinheiro; o fix correspondente:
>
> 1. **Comissão do Faturado é calculada AO VIVO**, não do snapshot. As linhas derivadas da agenda (`origem='agenda'`) nascem e seguem com `comissao_cents=0` congelado — **nada congela na realização**: o split previsão×faturado é stateless por `fim_at` (decisão 2/6), **sem cron** que vire `agendado→realizado`. Somar o snapshot devolvia **R$0** no Faturado mesmo com atendimento realizado. Decisão do Bruno: o relatório de comissão calcula o Faturado **AO VIVO** — `round(GREATEST(valor-desconto,0) * pct corrente / 100)` com `clone_colaboradores.comissao_pct`, **a MESMA fórmula da Previsão**, só com a janela do passado (`fim_at <= now()`). (Implementado em `getComissao`; o `pctExpr`/`comissaoExpr` ficou idêntico nos dois baldes, mudando só o predicado de janela.)
>    - **Trade-off aceito:** se o operador muda o `comissao_pct` de um profissional, o Faturado já fechado **recalcula** com o pct novo (não há histórico imutável do pct vigente na data do atendimento). Para gestão de salão é aceitável. **Refinamento contábil futuro (fora deste escopo):** snapshot-ao-realizar — congelar `comissao_cents` no instante em que `fim_at` passa (exigiria o cron de realização que a decisão 2 dispensou) — daria histórico imutável; HOJE é **live-compute** e isso é deliberado.
> 2. **Pacote não dobra a receita.** Quando o agendamento foi pago via pacote, o gancho (bot/portal) passa `forma_pagamento='pacote'` ao upsert → `valor_cents=0` (a receita já entrou na venda do pacote, ADR 0025). Antes, o gancho não recebia o resultado da dedução e a linha contava a receita 2×.
> 3. **Data/hora no fuso da barbearia (BRT).** O label do dia/hora no portal era formatado no fuso do runtime (UTC no SSR) → dia errado pra horários noturnos. Fixado em `America/Sao_Paulo` (`apps/portal-web/src/lib/format.ts`).

---

## Contexto

O ADR 0026 cravou `atendimentos` como fonte da verdade do financeiro do negócio do cliente (faturamento + comissão), com migration 058 (LIVE, flag `ATENDIMENTOS_ENABLED`). A Fase 1 (registro manual pelo painel + relatórios de faturamento/comissão) está em produção. O 0026 deixou a **Fase 2 — Integração** como "ponte bot/agenda → `atendimentos`" com um conjunto de questões em aberto (reconciliação da dupla contagem, divergência GCal × painel, status). Este ADR fecha essa Fase 2 com as decisões do Bruno, que **simplificam** o desenho original.

A visão: **o atendimento nasce sozinho a partir da agenda**, sem o operador re-digitar o que já agendou. Quem agenda (bot ou portal) já sabe o serviço, o profissional e o horário — falta só virar linha financeira. O painel passa a mostrar duas visões: **previsão** (o que está agendado pra frente) e **faturado** (o que já passou), por profissional.

Achado-chave (confirmado no código): **não existe webhook/push/watch nem polling do Google Calendar** neste projeto. `packages/integrations/src/google-calendar/` só resolve agendas por clone (`getGcalsForSlot`) e cria/edita/apaga eventos sob comando do app; não há `events.list`/`syncToken`/push notification. Logo, **não há como o Google nos avisar** de uma mudança feita direto no app do Google. A consequência arquitetural é dura: o atendimento tem de nascer **no momento do agendamento** (on-booking), no nosso lado, nunca por varredura.

Restrições que moldam a decisão (constantes do projeto):

- **Sem ORM.** Schema é responsabilidade explícita: migration SQL raw idempotente e aditiva versionada por `schema_migrations` (`scripts/migrate.sh`). 058 já existe → próximo número livre: **059**.
- **Isolamento P0 (ADR 0018):** toda linha já carrega `slot` (FK → `flow_clones`) + `tenant_id UUID` desde 058 — caminho de RLS, mantido.
- **Reversível e aditivo:** nenhum pagante pode ser afetado. 059 só adiciona colunas/índice; o gancho do bot fica atrás de flag nova `ATEND_FROM_AGENDA` (default OFF).
- **Começar do zero, sem backfill.** Nada de varrer agendas/eventos passados pra popular atendimentos.

---

## Decisão

**O atendimento passa a ser DERIVADO da agenda: criado ON-BOOKING (no momento em que o bot ou o portal cria o evento no Google Calendar), ligado a ele por `gcal_event_id`, e mantido em sync por evento.** O registro manual do 0026 (walk-in, `gcal_event_id NULL`) continua válido e convive com o derivado.

Cravamos seis pontos:

1. **Create-on-booking, nunca polling.** Como o Google não nos avisa de mudanças (não há webhook — ver Contexto), o atendimento nasce no nosso lado, no mesmo fluxo que cria o evento. Toda mudança que importa (criou, remarcou, trocou serviço, cancelou) passa **primeiro pelo nosso app** — é ali que sincronizamos. Mudança feita direto no app do Google fica fora de escopo por design (custo de polling/quota não se justifica pra 1 dono de salão).

2. **Previsão × faturado é stateless, derivado do tempo.** Não há coluna de "status pago/realizado" pra manter; o split é uma função de `fim_at <= now()`: evento futuro = **previsão**, evento já terminado = **faturado**. Sem cron, sem job que "vira" o atendimento. O relatório de comissão e o de faturamento filtram por isso em SQL. (O `status` herdado de 058 deixa de ser o eixo do split.)

3. **Comissão só sobre FATURADO.** Previsão **não** gera comissão a pagar. A tela mostra, por profissional, **faturado vs previsto** (previsto é só visão/projeção, nunca entra no "a pagar"). Mantém-se o snapshot de comissão do 0026 (`comissao_pct`/`comissao_cents` congelados na linha), mas o relatório de comissão a pagar soma **apenas** linhas com `fim_at <= now()`.

4. **No-show/cancelou = o usuário REMOVE e some.** Sem aba "Cancelados", sem `cancelado_em`/`cancelado_motivo`, sem trilha de motivo. Cancelar/excluir o evento → **soft-delete da linha** (`deleted_at`), que some de toda visão. Apagar um atendimento **já faturado** = simplesmente some do faturamento (sem estorno, sem trilha append-only). Implementado como soft-delete filtrado de todos os relatórios — nunca DELETE físico (reversível; auditável no banco se preciso).

5. **Edição de valor é STICKY (pin por coluna).** Se o serviço é R$50 e o cliente pagou R$40, o operador edita pra 40 e o billing conta 40 — e o **sync posterior da agenda NÃO** volta pro preço do catálogo. Mecanismo: `dirty_fields JSONB` na linha registra quais colunas foram editadas à mão; o sync **nunca sobrescreve coluna pinada**. Vale pra linha de previsão E de faturado.

6. **Pacote/ledger (ADR 0025) fica SEPARADO e INTOCADO.** A "Fase E de estorno"/reconciliação de dupla contagem cravada como risco no 0026 **CAI**. Atendimento pago com crédito (`forma_pagamento='pacote'`) continua lançando `valor_cents=0` (regra do 0026); a baixa do crédito segue vivendo só no `package_redemptions` por `gcal_event_id`. Sem nova ponte atendimento↔ledger, sem estorno automático.

---

## Modelo de dados (migration 059 — aditiva sobre `atendimentos` de 058)

059 **só adiciona** colunas + um índice único parcial. Nenhum backfill, nenhum `DROP/DELETE/TRUNCATE`.

| Coluna nova | Tipo | Nota |
|---|---|---|
| `origem` | `VARCHAR(16) NOT NULL DEFAULT 'manual'` | `manual` (registro do painel, 0026) \| `agenda` (derivado on-booking). Validado no app. |
| `dirty_fields` | `JSONB NOT NULL DEFAULT '{}'` | pin por coluna: chaves = nomes de colunas editadas à mão (ex.: `{"valor_cents":true,"servico_nome":true}`). Sync nunca sobrescreve coluna presente aqui. |
| `inicio_at` | `TIMESTAMPTZ NULL` | início do evento (espelho do GCal; base da visão de agenda). |
| `fim_at` | `TIMESTAMPTZ NULL` | fim do evento — **eixo do split previsão×faturado** (`fim_at <= now()` = faturado). |
| `deleted_at` | `TIMESTAMPTZ NULL` | soft-delete (cancelou/no-show/excluiu). NOT NULL = linha some de toda visão. |

**Índice de unicidade (o coração do sync):**

```
CREATE UNIQUE INDEX IF NOT EXISTS uq_atend_slot_event
  ON atendimentos (slot, gcal_event_id)
  WHERE gcal_event_id IS NOT NULL AND deleted_at IS NULL;
```

UNIQUE **PARCIAL**: garante no máximo **1 atendimento vivo por evento por clone** (idempotência do create-on-booking — re-disparo do gancho faz UPSERT, não duplica). Não trava: (a) walk-in (`gcal_event_id NULL` — fora do índice); (b) re-uso de `event_id` após soft-delete (`deleted_at NOT NULL` sai do índice — coerente com a decisão 4). Isolado por `slot` (P0).

**Removido do desenho original:** `cancelado_em` / `cancelado_motivo` — não existem (decisão 4). Soft-delete via `deleted_at` é a única trilha.

Colunas de 058 mantidas como estão (`gcal_event_id`, `valor_cents`, `colaborador_id`, `comissao_pct`/`comissao_cents` snapshot, `servico_nome`, `forma_pagamento`, `slot`, `tenant_id`). `status` de 058 fica por compat, mas **deixa de ser o eixo** de previsão×faturado (agora é `fim_at`).

---

## Regras de sync (on-booking)

- **Criar evento (bot/portal)** → UPSERT em `atendimentos` por `(slot, gcal_event_id)`: `origem='agenda'`, copia `inicio_at`/`fim_at`/`servico_nome`/`valor_cents` (preço do catálogo) e resolve `colaborador_id`/`tenant_id` do clone. Snapshot de comissão congelado como no 0026.
- **Remarcar / trocar serviço (preserva `event_id`)** → sync atualiza `inicio_at`/`fim_at`/`servico_nome`/`valor_cents` — **exceto** colunas em `dirty_fields` (pin). Preservar o `event_id` no PATCH é o que evita reabrir a baixa de pacote do ADR 0025 (não há novo `gcal_event_id`, não há dupla baixa).
- **Editar à mão no painel** (ex.: valor cobrado ≠ catálogo) → grava a coluna **e** marca a chave em `dirty_fields`. A partir daí o sync respeita o pin (decisão 5, sticky).
- **Cancelar / excluir evento** → soft-delete da linha (`deleted_at = now()`). Some de toda visão; libera o `event_id` no índice parcial. Sem estorno de pacote (decisão 6 — ADR 0025 intocado).
- **Split de relatório** (stateless): previsão = `deleted_at IS NULL AND fim_at > now()`; faturado = `deleted_at IS NULL AND fim_at <= now()`. Comissão a pagar soma só faturado.

---

## Endpoints

- `POST /portal/atendimentos` — **já existe** (0026, registro manual / walk-in). Mantido.
- `GET /portal/relatorios/faturamento` — **já existe**. Passa a filtrar `deleted_at IS NULL` e a expor o eixo previsto×faturado por `fim_at`.
- `GET /portal/relatorios/comissao` — **já existe**. Passa a somar **só** linhas faturadas (`fim_at <= now()`).
- `PATCH /portal/atendimentos/:id` — editar valor/serviço à mão → grava `dirty_fields` (sticky). **Novo** (Fase B1).
- `DELETE /portal/atendimentos/:id` — soft-delete (`deleted_at`). **Novo** (Fase B1).
- Gancho interno **create/sync-on-booking** disparado pelo fluxo que cria/edita/cancela evento no GCal (bot e `PATCH /portal/agendamentos/:eventId`). **Novo** (Fase B2/D), gated por `ATEND_FROM_AGENDA`.

Todas escopadas por `slot` da sessão e atrás de `ATENDIMENTOS_ENABLED` (404 se OFF), padrão do 0026.

---

## Alternativas descartadas

### Polling/sync do Google Calendar (varredura ou `watch`/push)
- **Pros:** pegaria mudanças feitas direto no app do Google.
- **Contras (decisivos):** não há webhook hoje; montar `watch`+canal push ou polling com `syncToken` é infra nova, quota/rate-limit e estado de sincronização pra manter — caro pra um ganho marginal (o dono agenda pelo nosso fluxo). **Descartada:** create-on-booking cobre 100% do que passa pelo nosso lado, com custo zero.

### Flag de status na linha pra previsão×faturado (em vez de `fim_at`)
- **Pros:** consulta trivial por igualdade.
- **Contras:** exige um job/cron pra "virar" agendado→realizado quando o horário passa — estado que pode atrasar/falhar e gera divergência. **Descartada:** `fim_at <= now()` é stateless, sempre correto, sem cron.

### DELETE físico no cancelamento
- **Pros:** tabela enxuta.
- **Contras:** irreversível, sem auditoria, e colidiria com `gcal_event_id` re-usado. **Descartada** pela regra de ouro (sem DELETE) e pela decisão 4 (soft-delete `deleted_at`).

### Estorno obrigatório / trilha append-only ao apagar faturado (Fase E do 0026)
- **Pros:** rastro contábil formal de cada baixa.
- **Contras:** Bruno decidiu que apagar um faturado **simplesmente some** (sem estorno, sem trilha por linha) — é gestão de salão, não contabilidade fiscal. Append-only só onde já existe e faz sentido: `package_redemptions` (ADR 0025), intocado. **Descartada** por decisão do Bruno (decisões 4 e 6).

---

## Consequências (positivas)

- O operador para de re-digitar o que já agendou: agenda → atendimento automático.
- Previsão × faturado sem cron e sempre correto (função do relógio, não de estado mutável).
- Edição sticky resolve "cobrei diferente do catálogo" sem o sync atropelar o operador.
- Soft-delete dá "sumir é simples" pro usuário e auditável no banco pra nós, sem inventar aba de cancelados.
- ADR 0025 (pacotes) sai do caminho crítico: a dupla-contagem que assombrava o 0026 deixa de existir (sem ponte nova, `valor_cents=0` no pacote, sem estorno).
- Aditivo + flag OFF: pagante intocado; reversível por `ALTER TABLE DROP COLUMN`/`DROP INDEX` (release separada).

## Riscos / Trade-offs

- **Mudança feita direto no Google (fora do nosso app) não sincroniza.** Aceito por design (sem webhook). Mitigação social: o cliente agenda pelo bot/portal; se editar no Google, edita também no painel.
- **`event_id` re-usado após soft-delete** — o índice parcial libera, mas duas linhas (uma deletada, uma viva) pro mesmo `event_id` exigem o filtro `deleted_at IS NULL` em toda leitura. Cravado nas queries; teste de regressão obrigatório.
- **`dirty_fields` como JSONB de flags** é simples mas não versiona o valor antigo. Aceito: queremos pin, não histórico de edição.
- **`status` de 058 fica órfão** do split. Não removido (aditivo), mas documentado como não-eixo pra não confundir leitura futura.

## Plano faseado (incremental, reversível)

- **Fase A — este ADR + migration 059.** Colunas (`origem`, `dirty_fields`, `inicio_at`, `fim_at`, `deleted_at`) + índice único parcial. Aditiva, sem backfill.
- **Fase B1 — endpoints de atendimento (já em construção).** `PATCH`/`DELETE /portal/atendimentos/:id` (sticky + soft-delete); relatórios filtram `deleted_at` e usam `fim_at` pro split. Não toca o fluxo de agendamento.
- **Fase B2 — gancho create/sync-on-booking + sync de linha.** Liga o create/edit/cancel de evento → UPSERT/soft-delete em `atendimentos`. **Depende do PR #347** (conserta DELETE/PATCH do estabelecimento) — sem ele o sync de evento no estabelecimento fica inconsistente.
- **Fase C — telas previsão×faturado por profissional.** UI de agenda do portal mostra previsto vs faturado e comissão só sobre faturado.
- **Fase D — gancho do BOT (por último), gated por `ATEND_FROM_AGENDA`.** O bot, ao agendar, dispara o create-on-booking. Flag nova default OFF; liga primeiro num clone de teste. Último porque é o caminho de maior blast radius (toca produção do WhatsApp).

## Validação (DoD)

- Migration 059 idempotente (roda 2×, 2ª é no-op), aditiva, com bloco de rollback no cabeçalho. Nenhum `DROP/DELETE/TRUNCATE` sobre dado existente.
- Índice único parcial barra 2º atendimento vivo pro mesmo `(slot, event_id)`; permite walk-in e re-uso pós-soft-delete (teste cobre os 3 casos).
- Split: linha com `fim_at` no futuro aparece em previsão e nunca soma comissão a pagar; com `fim_at` no passado aparece em faturado e soma. Sem cron envolvido.
- Sticky: editar `valor_cents` à mão marca `dirty_fields`; sync subsequente do mesmo evento **não** sobrescreve. Editar é durável (previsto e faturado).
- Soft-delete: atendimento apagado some de faturamento/comissão/agenda; `package_redemptions` (ADR 0025) permanece byte-a-byte intocado.
- `ATEND_FROM_AGENDA` OFF → nenhum atendimento derivado é criado; produção idêntica; WAHA/bots intocados.
