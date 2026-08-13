# Missão 028 — Retry WAHA sem perda sob saturação

**DRI:** backend-senior
**Agentes envolvidos:** backend-senior (implementação), qa-tester (regressão), security (revisão de idempotência)
**Apetite:** pequeno (até 1 dia, uma PR sem migration/env)
**Status:** implementada na branch `fix/stability-webhook-retry`
**ADRs relacionados:** 0019 (idempotência Redis) e 0021 (webhook assíncrono/ACK-early, referência no código)

## Problema e causa raiz

Com `WEBHOOK_ASYNC=true`, a rota executava `SET NX` do dedup antes de pedir um slot ao `AsyncRunner`. Com quatro tarefas em voo, a quinta mensagem era marcada como vista e só depois recusada com `503 busy:retry`. Quando o WAHA retentava o mesmo `messageId`, o Redis já continha a chave e a rota respondia `200 ignored:dedup`: a mensagem nunca entrava no router.

O invariante correto é: uma chave de dedup significa **admitida para processamento**, não apenas recebida pelo endpoint.

## Objetivo

Garantir que saturação não consuma idempotência: `503` não cria chave; após surgir vaga, o retry do mesmo `(sessão, messageId)` é aceito e processado exatamente uma vez.

## Escopo

- Reordenar o caminho assíncrono para reservar capacidade antes do dedup.
- Manter dedup antes do `200 accepted` e manter `skipDedup=true` no router.
- Preservar fail-open do Redis, exceção de `message.ack`, HMAC sobre raw body, limites e timeout do runner.
- Cobrir deterministicamente quatro slots ocupados, quinta mensagem recusada e retry após liberação.

## Concorrência e invariantes

- `AsyncRunner.schedule()` adquire o slot de forma síncrona, antes do primeiro `await`; só a tarefa admitida alcança o `SET NX`.
- Requests concorrentes não passam por um check separado de `isSaturated`, evitando TOCTOU.
- Retry enquanto ainda saturado continua recebendo `503` sem mutação; após vaga, apenas o primeiro retry marca a chave.
- Retries posteriores encontram a chave e retornam `ignored:dedup`; o router processa o ID uma única vez.
- Duplicatas legítimas ocupam um slot apenas durante o check Redis e o liberam ao retornar, sem reduzir a proteção existente.

## Definition of Done (DoD)

- [x] Teste vermelho prova `503` seguido de `ignored:dedup` no código anterior.
- [x] O mesmo teste fica verde: retry retorna `accepted` e chama o router exatamente uma vez.
- [x] Testes de HMAC, dedup e `AsyncRunner` permanecem verdes.
- [x] Build TypeScript e suíte completa verdes.
- [x] Zero alteração em schema, env, contrato HMAC, WAHA, produção ou frontend.

## Riscos

- O slot passa a incluir a curta espera do Redis (limitada por `IDEMPOTENCY_REDIS_TIMEOUT_MS`). É intencional: capacidade precisa existir antes de gravar a idempotência; em falha, o dedup continua fail-open.
- O contrato de `checkAndMarkDuplicate` é não lançar. Se ele mudar no futuro, a admissão HTTP deve ganhar resultado explícito de erro para nunca aguardar indefinidamente.

## Rollback

Reverter a única PR/commit. Não há migration nem dado persistente novo. Como mitigação operacional imediata, `WEBHOOK_ASYNC=false` volta ao caminho síncrono; não é necessário desligar HMAC nem dedup.

## Fora de escopo

- Alterar TTL/política fail-open do Redis, limites do runner ou retry configurado no WAHA.
- Criar fila externa, persistência local, ordenação por conversa ou scale-out.
- Deploy, flag, restart, push, PR ou qualquer ação em produção.
