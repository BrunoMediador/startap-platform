# ADR 0010: Worker BullMQ — usar de verdade ou remover?

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0010-worker-bullmq.md`

---

**Status:** proposta — aguardando aprovação de Bruno
**Data:** 2026-05-19
**Autor:** arquiteto
**Aprovado por:** pendente

---

## Contexto

`apps/worker/package.json` declara `bullmq@^5.34.0` e `ioredis@^5.4.2` como dependências de produção, mas `apps/worker/src/worker.ts` não importa BullMQ em nenhuma linha — usa exclusivamente `croner` para dois jobs periódicos: `antibot` (a cada minuto) e `cleanup-chat` (a cada hora). A dependência nunca foi inicializada, nunca conectou no Redis em tempo de execução.

Paralelamente, a auditoria de 2026-05-19 identificou dois `setTimeout` fire-and-forget no envio de mídia após marcadores da IA:

- `apps/api/src/bots/teste_vendas.ts:306` — atraso de 2500ms antes de `handleMarker`
- `apps/api/src/bots/teste_vendas_barbearia.ts:540` — mesmo padrão

O `setTimeout` existe para dar tempo ao WAHA de processar a mensagem de texto antes de enviar a mídia. Se o processo da API reiniciar durante esses 2,5 segundos (deploy, crash), a mídia é perdida silenciosamente — sem log de erro, sem retry.

Além disso, `packages/db/src/queries/flow-execution-log.ts` possui `closeStaleRunning` que era chamada apenas quando a função era importada diretamente — auditoria confirmou que a chamada real existe no worker (`worker.ts:76`), portanto esse item foi resolvido.

**Volume estimado de jobs de mídia:** plataforma processa ~100-200 mensagens/dia nos bots de teste. A taxa de marcadores de mídia é uma fração (estimativa conservadora: 10-30 envios de mídia/dia). Jobs de mídia são de curta duração (<5s) e baixo volume — não há pressão de throughput.

**Infraestrutura:** Redis já está no stack (usado pela API para rate limiting e cache de sessão). O custo marginal de manter BullMQ ativo em termos de memória Redis é baixo (~2-5MB para metadados de filas com esse volume).

**Disco VPS:** memória `project_vps_disco_apertado` — 72/100GB usado. BullMQ com AOF Redis não adiciona storage significativo nesse volume de jobs; não agrava o problema de disco.

---

## Decisão

**Opção A escolhida: remover BullMQ e resolver o setTimeout com `await` + delay explícito.**

O `setTimeout` de 2,5s não é um problema de fila — é um problema de ordenação de mensagens WAHA. A solução correta é transformar o `setTimeout` em `await delay(2500)` seguido de `await handleMarker(...)` dentro do mesmo contexto async, eliminando o fire-and-forget sem introduzir infraestrutura de fila. BullMQ deve ser removido como dependência morta. Os jobs periódicos (`antibot`, `cleanup-chat`) permanecem em `croner` — adequado para sua natureza de manutenção.

---

## Alternativas consideradas

### Opção A — Remover BullMQ + await inline ← **ESCOLHIDA**
- **Como funcionaria:** `setTimeout(..., 2500)` vira `await delay(2500); await handleMarker(...)`. `bullmq` e `ioredis` removidos do `package.json`. `croner` mantido.
- **Pros:** elimina dependência morta; resolve falha silenciosa de mídia; sem nova infra; sem mudança no container Redis; stack mais simples.
- **Contras:** se o processo cair nos 2,5s de delay, a mídia ainda é perdida (mas o crash durante `await delay` é detectável via log — diferente do setTimeout silencioso). Não resolve perda em crash do processo — só em crash durante o fire-and-forget.
- **Escolhida porque:** o volume de jobs não justifica a complexidade operacional de BullMQ (filas, DLQ, Redis persistence, dashboard). A perda de uma mídia em deploy é aceitável dado o contexto de testes — não é produção de cliente final. Simplifica o stack imediatamente.

### Opção B — Ativar BullMQ de verdade
- **Como funcionaria:** criar fila `media-dispatch` no BullMQ; `handleMarker` vira um job enfileirado; worker consome e executa; DLQ com 3 retries.
- **Pros:** mídia nunca perdida em deploy/crash; visibilidade de jobs; DLQ.
- **Contras:** adiciona ~200 linhas de infraestrutura (producer no API, consumer no worker, tipos compartilhados, configuração de conexão); exige Redis persistente (AOF); aumenta superfície de falha (fila corrompida, Redis downtime); overhead de manutenção permanente para 10-30 jobs/dia.
- **Descartada porque:** custo de implementação e manutenção desproporcionalmente alto para o volume. Os bots afetados são roteadores de teste, não instâncias de clientes em produção.

### Opção C — Híbrido mínimo: BullMQ só para mídia
- **Como funcionaria:** criar apenas a fila `media-dispatch`; manter `croner` para os jobs periódicos.
- **Pros:** confiabilidade de mídia sem refatorar os jobs periódicos.
- **Contras:** ainda introduz BullMQ ativo com todo custo de configuração e manutenção. Tem todos os contras da Opção B, só reduz o escopo inicial.
- **Descartada porque:** para 10-30 jobs/dia, `await delay` resolve o mesmo problema sem infraestrutura extra.

### Opção D — Fila no Postgres (tabela `jobs_queue` + polling)
- **Como funcionaria:** INSERT na tabela `jobs_queue` antes de responder; worker faz SELECT + DELETE e executa; sem Redis.
- **Pros:** sem dependência externa; auditável.
- **Contras:** reinventa primitivo de fila com polling ativo; latência de polling (1-5s) somada ao delay de 2,5s; complexidade similar à Opção B sem os benefícios do ecossistema BullMQ.
- **Descartada porque:** mais complexo que a Opção A e pior que a Opção B em todas as dimensões exceto dependência de Redis (que já existe no stack).

---

## Consequências

### Positivas
- `handleMarker` passa a ser `async/await` completo — erro é capturável e logável no mesmo contexto.
- Remoção de `bullmq` e `ioredis` do `package.json` de `apps/worker` elimina 2 dependências pesadas do bundle de produção (~1.5MB).
- Stack worker fica: `croner` + `@startap/db` + `@startap/integrations`. Sem Redis no worker.
- Caminho limpo para introduzir BullMQ no futuro se volume crescer (decisão reversível).

### Negativas / trade-offs
- Crash do processo durante `await delay(2500)` ainda perde a mídia — mas agora com log explícito ao invés de silêncio.
- Se no futuro surgir necessidade real de fila (ex: notificações assíncronas em lote para clones), será necessário reintroduzir BullMQ. Porém esse é um ADR separado, com PR-FAQ e volume justificado.

### Neutras
- `croner` permanece adequado para antibot e cleanup. Esses jobs são idempotentes e tolerantes a perda (rodam novamente no próximo ciclo).

---

## Plano de migração

1. Em `apps/api/src/bots/teste_vendas.ts:304-319`: substituir bloco `if (type !== null) { setTimeout(() => { ... }) }` por `if (type !== null) { await delay(2500); await this.handleMarker(...); }` — onde `delay` é um utilitário em `packages/core/src/utils.ts` (função de 2 linhas, já existe padrão similar no codebase).
2. Mesmo padrão em `apps/api/src/bots/teste_vendas_barbearia.ts:538-555`.
3. Remover `"bullmq"` e `"ioredis"` de `apps/worker/package.json`.
4. Rodar `npm install` para atualizar `package-lock.json`.
5. Verificar que `apps/worker/src/worker.ts` não importa BullMQ (já confirmado — não importa).

**Estimativa:** <50 linhas modificadas. Não requer ADR de implementação — abaixo do limiar de 300 linhas.

---

## Validação

- `grep -r "bullmq\|ioredis" apps/worker/` retorna vazio após a mudança.
- `grep -r "setTimeout" apps/api/src/bots/` retorna vazio (os dois únicos setTimeout identificados são de mídia).
- Build `npm run build --workspaces` passa sem erros.
- Smoke test: enviar mensagem que dispara `[VIDEO:<id>]` em ambiente de staging — mídia deve ser entregue com log de sucesso visível.

---

## Rollback

- O plano de migração é reversível: reverter os dois arquivos de bot para `setTimeout` e restaurar `bullmq`/`ioredis` no `package.json`.
- Git revert do PR é suficiente — sem migration de banco, sem mudança de infraestrutura.

---

## Referências

- Missão 015: `docs/missoes/015-onda-3b-adr-worker-bullmq.md`
- Auditoria 2026-05-19: `docs/auditorias/2026-05-19-fase-0-vps-disco-e-backup.md`
- `apps/worker/src/worker.ts` — confirma uso exclusivo de croner
- `apps/worker/package.json` — confirma bullmq/ioredis declarados mas não usados
