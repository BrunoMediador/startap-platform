# ADR 0019: Lock de Idempotência (Redis) — Pré-requisito para 2ª Instância da API

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0019-idempotencia-lock-redis.md`
> **Quando usar:** Pilar 2 dos "3 pilares de escala" (decisão do Bruno, 2026-06-12). Pré-requisito para rodar mais de uma instância da API sem responder a mesma mensagem 2x nem criar 2 eventos no Google Calendar.

---

**Status:** proposta — aguardando aprovação de Bruno
**Data:** 2026-06-12
**Autor:** arquiteto
**Aprovado por:** pendente
**Relacionados:** ADR 0010 (worker BullMQ — Redis já no stack, sem BullMQ), ADR 0006 (GCal por clone), ADR 0014 (advisory lock `withBillingSlotLock` — precedente de lock). Faz par com ADR 0018 (tenant_id) e ADR 0020 (shard WAHA).

---

## Contexto

### Estado real (confirmado no código, 2026-06-12)

A API hoje assume **instância única**. Não há dedup de mensagem real e não há lock distribuído:

- **`apps/api/src/routes/webhook-waha.ts:24`** comenta "replay mitigado pelo dedupe de event.id" — mas **esse dedupe NÃO existe no código**. `grep -rn 'dedup|processed|seen|messageId'` na API não encontra nenhuma estrutura que descarte um `payload.id` já processado. A proteção contra duplicata hoje é **implícita**: o handler retorna 200 (WAHA não retenta) e só há 1 processo. O `messageId` é extraído em `router.ts:590` mas **nunca usado para dedup**.
- **Não há cliente Redis na API.** `grep -rn 'redis|ioredis|createClient'` em `apps/api/src` só acha `REDIS_HOST`/`REDIS_PORT` no schema de config e um **TCP ping** em `routes/health.ts:74`. Redis está no stack (container `startap-redis`, healthy) mas a API **não conecta nele** para nada funcional.
- **Único lock que existe é no Postgres:** `packages/db/src/queries/billing-charges.ts:191` `withBillingSlotLock` usa `pg_advisory_xact_lock(hashtext('billing:'||slot))` para serializar geração de cobrança. É o **precedente de lock por tenant** que vamos espelhar conceitualmente.
- **Crons (croner) assumem instância única.** `apps/worker/src/worker.ts`: `antibot` (cada 1min), `cleanup-chat` (cada hora), `close-stale-running` (cada 15min), `generate-billing-charges` (1x/dia), `cleanup-trial-orphans`. Se uma 2ª instância do **worker** subir, **todo cron roda 2x**. O billing já é protegido por advisory lock; os demais (antibot, cleanups) são idempotentes por natureza, mas `generate-billing-charges` fora do lock seria problema.

### O risco concreto quando subir a 2ª instância

Sem lock de idempotência, com 2 instâncias da API atrás de um load balancer:

1. **Resposta dupla:** se a WAHA reenviar o mesmo evento (retry por timeout) ou se o LB distribuir um retry para a outra instância, **as duas processam a mesma mensagem** e o cliente recebe 2 respostas. Hoje isso não acontece só porque há 1 instância.
2. **Evento GCal duplicado:** o pior caso. O bot da barbearia cria evento no Google Calendar (ADR 0006). Duas execuções da mesma mensagem = **2 agendamentos** no calendário do Cirilo. Isso é dano visível ao cliente pagante.
3. **Cron duplicado:** 2 workers = `generate-billing-charges` rodando 2x → o advisory lock por slot salva o billing, mas qualquer cron novo sem lock duplicaria efeito.

### Restrições que moldam a decisão

- **Redis 7 já está no stack** e é "boring tech" aprovada (ADR 0010 manteve Redis sem BullMQ). Custo marginal de usar Redis para locks/dedup é desprezível.
- **Sem BullMQ** (ADR 0010). Lock e dedup são primitivos simples (`SET NX EX`), não justificam fila.
- **A constraint dura do Bruno (zero downtime / zero re-pareamento)** é satisfeita: este pilar é 100% app + Redis, **não toca WAHA**.
- **Ordem importa:** este lock precisa existir e estar validado em produção COM 1 instância ANTES de qualquer 2ª instância subir. O lock é inócuo com 1 instância (sempre adquire), o que permite validar o caminho sem mudar comportamento.

---

## Decisão

**Introduzir um cliente Redis na API/worker e dois primitivos sobre ele, atrás de flags, validados primeiro com instância única (onde são no-op funcional):**

1. **Dedup de evento de mensagem** (`IDEMPOTENCY_DEDUP`): antes de processar um evento de mensagem, `SET dedup:msg:<sessao>:<messageId> 1 NX EX <ttl>`. Se a chave já existe (NX falha) → o evento já foi/está sendo processado → **descartar** (log `router.ignored reason=dedup`, retornar 200). TTL curto (ex.: 300s) cobre janela de retry da WAHA sem reter memória.
2. **Lock de ação com efeito externo** (`IDEMPOTENCY_ACTION_LOCK`): para ações que criam efeito não-reversível externamente (envio de resposta WAHA, criação de evento GCal), envolver com um lock distribuído curto por chave de ação (ex.: `lock:gcal:<slot>:<telefone>:<slotDeHorario>` e `lock:reply:<sessao>:<messageId>`). Lock = `SET <key> <token> NX PX <ms>`, release com check-and-del (Lua) ou simplesmente expira. Garante exclusão mútua entre instâncias.

**Chave de idempotência = `(sessao, messageId)`** para o dedup de mensagem (granularidade de evento WAHA), e chave semântica por ação para o lock de efeito externo (ex.: GCal por `(slot, telefone, horário)` evita 2 eventos mesmo se 2 mensagens distintas pedirem o mesmo horário).

**Padrão de implementação:** cliente Redis singleton no boot da API/worker (reusar `REDIS_HOST`/`REDIS_PORT` que já estão no config). Falha de Redis = **fail-open com 1 instância** (se Redis cair, processa mesmo assim — não derruba o bot) e **fail-closed só quando a 2ª instância existir** (decisão por flag no momento do scale-out). Isso preserva disponibilidade hoje e correção amanhã.

### Por que Redis e não Postgres advisory lock para o dedup de mensagem

O `withBillingSlotLock` (advisory lock no PG) é ótimo para serializar uma transação de banco. Mas o dedup de mensagem precisa de uma chave com **TTL** (a janela de retry da WAHA), que advisory lock não tem nativamente sem uma tabela de controle + cron de limpeza. Redis `SET NX EX` é o primitivo natural, sem nova tabela, sem cron de limpeza, sem crescimento de banco. Redis já está no stack. Para o **lock de ação externa**, Redis `SET NX PX` com token também é o primitivo certo (lock curto com expiração automática, sem risco de lock órfão se a instância morrer).

---

## Alternativas consideradas

### Opção A — Redis `SET NX EX` para dedup + `SET NX PX` para lock de ação, fail-open hoje / fail-closed no scale-out ← **ESCOLHIDA**
- **Pros:** primitivo simples e batido; Redis já no stack; TTL nativo (sem cron de limpeza); inócuo com 1 instância (valida sem mudar comportamento); não toca WAHA.
- **Contras:** introduz dependência funcional de Redis no caminho quente da mensagem (mitigado por fail-open hoje); precisa de cliente Redis novo na API (não existe hoje).
- **Escolhida porque:** é o menor passo reversível que torna a API segura para N instâncias, reusando infra existente.

### Opção B — Dedup via tabela Postgres (`processed_events` + UNIQUE + cron de prune)
- **Pros:** sem dependência nova no caminho quente; auditável; padrão já usado em `billing_webhook_events` (UNIQUE event_id).
- **Contras:** cada mensagem vira um INSERT (+ crescimento de tabela + cron de prune); latência de banco no caminho quente; reinventa TTL que Redis dá de graça.
- **Descartada porque:** Redis dá TTL e velocidade sem cron de limpeza. (Nota: para **webhooks de billing**, a tabela `billing_webhook_events` continua sendo a escolha certa — baixo volume, precisa de auditoria. O dedup de **mensagem WhatsApp** é alto volume e efêmero → Redis.)

### Opção C — Advisory lock no Postgres para tudo (estender o padrão `withBillingSlotLock`)
- **Pros:** reusa o precedente; sem dependência nova.
- **Contras:** advisory lock não tem TTL — exige conexão viva segurando o lock durante todo o processamento (custa conexão do pool por mensagem); risco de lock órfão se a conexão cair; serializa demais.
- **Descartada porque:** segura conexão do pool por mensagem (caro no caminho quente) e não tem expiração automática.

### Opção D — Idempotência só no nível do worker de cron (Redis lock por job), sem dedup de mensagem
- **Pros:** menor escopo; protege os crons.
- **Contras:** não resolve o pior caso (resposta/GCal duplicado da API). Resolve metade do problema.
- **Descartada porque:** o dano visível ao cliente (2 respostas, 2 eventos GCal) vem da API, não do cron. Precisa cobrir os dois. (O lock de cron entra como sub-passo barato dentro deste ADR.)

---

## Consequências

### Positivas
- API fica **segura para N instâncias**: pré-requisito real do scale-out horizontal.
- Mata o pior caso de duplicidade visível (resposta dupla, 2 eventos GCal) que hoje só não acontece por sorte (1 instância).
- Documenta e implementa o "dedupe de event.id" que o código já afirmava existir mas não existia (corrige uma mentira de comentário em `webhook-waha.ts:24`).
- Lock de cron protege o worker contra execução dupla quando houver 2 workers.
- Não toca WAHA → atende a constraint dura do Bruno.

### Negativas / trade-offs
- Dependência funcional de Redis no caminho quente (mitigada por fail-open com 1 instância; vira fail-closed só no scale-out, decisão consciente por flag).
- Cliente Redis novo na API/worker (código novo, ~revisar conexão/reconnect/timeout).
- TTL do dedup é um trade-off: curto demais = janela de retry da WAHA pode escapar; longo demais = retém chaves. Default proposto 300s, ajustável por env.

### Neutras
- O advisory lock de billing (`withBillingSlotLock`) **permanece** — não é substituído. Redis cobre mensagem/ação; PG advisory cobre a transação de cobrança. Cada um na sua camada.

---

## Plano de migração (incremental, flag-gated, reversível)

### Passo 1 — Cliente Redis singleton na API/worker (sem mudar comportamento) — **seguro online**
- Adicionar módulo de conexão Redis (reusar `REDIS_HOST`/`REDIS_PORT`). Health check já pinga Redis (`health.ts`) — só falta o client funcional.
- Nenhuma lógica de dedup/lock ainda — só a conexão + log de status no boot.
- **Gate de risco:** BAIXO. Conexão ociosa não muda nenhum caminho.
- **Validação:** boot loga `redis connected`; `/health` continua verde; nenhuma mudança de resposta de bot.
- **Rollback:** remover o módulo (não é referenciado por nada ainda).
- **Apetite:** 1 dia (`backend-senior`).

### Passo 2 — Dedup de mensagem atrás de `IDEMPOTENCY_DEDUP` (fail-open) — **seguro online, validar com 1 instância**
- No `handleWebhook` (`router.ts`), após validar que é evento de mensagem e extrair `messageId`, fazer `SET dedup:msg:<sessao>:<messageId> NX EX <ttl>`. Se já existe → descartar com log `dedup`. Se Redis indisponível → **processar mesmo assim** (fail-open) e logar warn.
- Flag OFF = comportamento atual (sem dedup). Flag ON com 1 instância = inócuo funcionalmente (nunca há corrida), mas **observável**: o log mostra quantas duplicatas a WAHA realmente reenvia hoje (dado que não temos).
- **Gate de risco:** BAIXO-MÉDIO. Toca o caminho quente. Fail-open garante que bug de Redis não cala o bot.
- **Validação em prod SEM tocar sessões:** ligar a flag com 1 instância. Enviar mensagens normais para a sessão de **teste** (`WHATSAPP_ROUTER_TESTE` / clone de teste do Bruno) — nunca para Cirilo/Samuel primeiro. Verificar nos logs `flow_execution_logs` que: (a) mensagens normais passam (dedup não bloqueia legítimo); (b) se houver retry da WAHA, aparece `reason=dedup`. **Não há restart de WAHA, não há reconexão.**
- **Rollback:** flag OFF (instantâneo, sem deploy se a flag for lida em runtime; senão revert + deploy).
- **Apetite:** 2 dias (`backend-senior`; `qa-tester` valida não-regressão; `waha-specialist` confirma comportamento de retry da WAHA NOWEB).

### Passo 3 — Lock de ação com efeito externo atrás de `IDEMPOTENCY_ACTION_LOCK` — **seguro online, alto cuidado no GCal**
- Envolver criação de evento GCal e envio de resposta WAHA com lock distribuído por chave semântica. Chave GCal proposta: `lock:gcal:<slot>:<telefone>:<inicioISO>` (mesmo horário do mesmo cliente nunca cria 2 eventos, mesmo vindo de 2 mensagens).
- **Gate de risco:** MÉDIO-ALTO. Toca o caminho de agendamento do cliente PAGANTE (Cirilo). Validar exaustivamente em clone de teste antes.
- **Validação em prod SEM tocar sessões:** com 1 instância + flag ON, agendar pela sessão de teste e confirmar no GCal de teste que **1 evento** é criado. Tentar disparar 2 mensagens idênticas rápidas → 1 evento. **Só depois** de validado no teste, considerar com Cirilo (e mesmo assim, 1 instância não muda nada — o ganho real é no scale-out).
- **Rollback:** flag OFF.
- **Apetite:** 2-3 dias (`backend-senior` + `ai-engineer` se a criação de evento estiver no fluxo do agente + `qa-tester`).

### Passo 4 — Lock de cron no worker (`generate-billing-charges` e novos) — **seguro online**
- Lock Redis por nome de job antes de executar (ou confiar no advisory lock por slot que já existe para billing). Garante 1 execução por janela mesmo com 2 workers.
- **Gate de risco:** BAIXO (billing já protegido por advisory lock; isto é defesa em profundidade).
- **Validação:** subir 2 workers em staging → cada job roda 1x por janela.
- **Rollback:** flag OFF.
- **Apetite:** 1 dia (`backend-senior`).

### Passo 5 — Decisão de fail-closed no scale-out — **decisão Bruno, no momento de subir a 2ª instância**
- Quando a 2ª instância for subir (depende do ADR 0020 e de LB), trocar a política de Redis indisponível de fail-open para fail-closed (não processar sem lock confirmado), porque com 2 instâncias fail-open reintroduz o risco de duplicidade.
- **Não é deste release.** Registrado para não esquecer.

---

## Validação (DoD deste ADR)
- Cliente Redis conecta no boot; `/health` verde.
- Com `IDEMPOTENCY_DEDUP` ON e 1 instância: mensagens legítimas passam; retries da WAHA aparecem como `reason=dedup`; bot nunca cala por causa de Redis (fail-open).
- Com `IDEMPOTENCY_ACTION_LOCK` ON em teste: 2 mensagens idênticas → 1 evento GCal, 1 resposta.
- `vitest` cobre o caminho `SET NX` (chave nova → processa; chave existente → descarta).
- Zero restart/reconexão de `automacoes-waha-1`.

## Rollback
- Todos os passos são flag-gated → desligar a flag volta ao comportamento atual.
- O módulo Redis pode ser desabilitado por env (`IDEMPOTENCY_*=false`) sem remover código.

## O que precisa de decisão/aprovação do Bruno
1. **Aprovar dependência funcional de Redis no caminho quente** (com fail-open hoje). Recomendação: aprovar — Redis já está no stack e é boring tech.
2. **TTL do dedup** (proposto 300s) e **política fail-open hoje → fail-closed no scale-out** (passo 5).
3. **Ordem:** confirmar que este pilar é validado em prod (com 1 instância) ANTES de qualquer 2ª instância existir — o lock precede o scale-out.
4. Janela para validar o lock de GCal: usar **sessão de teste**, nunca Cirilo/Samuel primeiro.

## Referências
- `apps/api/src/routes/webhook-waha.ts:24` — comentário "dedupe de event.id" que NÃO existe no código (corrigir).
- `apps/api/src/router.ts:590` — `messageId` extraído mas não usado para dedup.
- `packages/db/src/queries/billing-charges.ts:191` — `withBillingSlotLock` (precedente de lock por tenant; permanece).
- `apps/worker/src/worker.ts` — crons croner que assumem instância única.
- `apps/api/src/routes/health.ts:74` — Redis hoje só recebe TCP ping (sem client funcional).
- ADR 0010 — Redis no stack, sem BullMQ.
- ADR 0006 — GCal por clone (alvo do lock de ação externa).
