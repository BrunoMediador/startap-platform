# Missão 012 — Onda 1: Críticos (A1-A8)

**DRI:** dev-back (principal) + infra (A4 backup, A8 disco)
**Agentes envolvidos:** dev-back, infra, tester, gerente-pr
**Apetite:** grande (até 5 dias úteis, ~1 semana)
**Status:** pendente
**Cliente (persona):** time técnico e Bruno — a branch atual está bloqueada (A1), o banco pode vazar credenciais de clientes (A2), e dados podem ser corrompidos silenciosamente (A5/A6/A7)
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (bugs críticos, não feature)

---

## Contexto

A auditoria de 2026-05-19 identificou 8 achados críticos que bloqueiam ou ameaçam a operação: testes quebrados impedem o merge da branch atual (A1), credenciais Google Calendar de clientes são armazenadas em texto claro no banco (A2), a senha padrão do painel é `admin:admin` (A3), o banco não tem backup (A4), a paginação de leads está quebrada (A5), existe uma rota com SQL injection latente (A6), a entrega de mídia usa `setTimeout` fire-and-forget (A7), e o VPS está com 72/100 GB ocupados (A8). Nenhuma outra missão pode avançar com segurança sem resolver esses itens.

## Restrições críticas

- Sem DROP/DELETE/TRUNCATE no banco — migrações apenas `ALTER`/`ADD`/`UPDATE`
- A8 (limpeza de disco) só executa após a Missão 011 entregar lista aprovada pelo Bruno
- Cada PR é independente e tem regressão validada pelo tester antes do merge
- Refactor acima de 300 linhas exige ADR primeiro (nenhum item aqui atinge esse limiar individualmente)

## Sub-missões / PRs (ordem de execução)

### PR-A1 — Fix mock `flowClones` + testes router (dev-back)
**Achado:** `apps/api/src/router.test.ts:22-36` — mock `flowClones` não foi atualizado pela Missão 010, 3 testes falhando, branch `feat/pairing-code-waha` bloqueada para merge.
**Escopo:** atualizar o mock para refletir a interface atual de `flowClones`; confirmar que os 3 testes passam; rodar suite completa de testes.
**Prioridade:** PRIMEIRA — desbloqueia a branch atual.

### PR-A8 — Investigação e limpeza de disco VPS (infra)
**Achado:** VPS em 72/100 GB. Pré-requisito de A4 (backup via Git).
**Escopo:** executar lista aprovada pela Missão 011; remover imagens Docker ociosas, logs volumosos, arquivos de mídia duplicados. Documentar espaço recuperado.
**Prioridade:** SEGUNDA — desbloqueia A4 (backup precisa de espaço livre).
**Bloqueio:** depende de Missão 011 (lista de candidatos aprovada pelo Bruno).

### PR-A2 — Criptografar `gcal_credentials_json` (dev-back)
**Achado:** `migration 018` + `server.js:2960` — JSON de credenciais Service Account salvo em texto claro em `flow_clones.gcal_credentials_json`.
**Escopo:** migration idempotente que adiciona coluna `gcal_credentials_json_enc` (encrypted); atualizar `PUT /api/clones/:id/gcal` para criptografar na escrita (AES-256-GCM com chave de env `GCAL_CRED_KEY`); atualizar leitura para descriptografar; manter coluna antiga como `NULL` após migração. PR separada de A3.
**Restrição:** chave de criptografia (`GCAL_CRED_KEY`) deve ser variável de ambiente — NUNCA hardcodada.

### PR-A3 — Remover default `admin:admin` no painel (dev-back)
**Achado:** `painel-admin/server.js:22` — `ADMIN_PASS` com fallback `'admin'`.
**Escopo:** remover fallbacks triviais; adicionar startup check que lança erro se `ADMIN_PASS` ou `ADMIN_USER` não estiverem definidos no env; atualizar `.env.example` com instrução clara.

### PR-A4 — Backup Postgres via Git privado (infra)
**Achado:** ausência total de backup do banco de produção.
**Escopo:** script `scripts/backup-postgres.sh` que faz `pg_dump`, comprime e commita em repo Git privado separado (conforme memória `project_backup_via_git`). Cron no VPS (diário, 03h00 BRT). Runbook atualizado.
**Bloqueio:** depende de A8 (espaço livre) + repo Git privado criado pelo Bruno.

### PR-A5 — Corrigir paginação `/api/leads` (dev-back)
**Achado:** `server.js:1973` — merge em memória JS após LIMIT 200 por tabela; página 2 nunca funciona corretamente.
**Escopo:** reescrever query com `UNION ALL` + `ORDER BY created_at DESC LIMIT $limit OFFSET $offset` direto no Postgres; adicionar header `X-Total-Count` na resposta; atualizar frontend para usar offset correto.
**Restrição:** grep em `painel-admin/public/index.html` antes de alterar shape da resposta (memória `feedback_remover_endpoint_grep_frontend`).

### PR-A6 — Sanar SQL injection em `DELETE FROM ${table}` (dev-back)
**Achado:** `server.js:3574` — interpolação direta de nome de tabela sem `safeTableName`.
**Escopo:** aplicar função `safeTableName` (já existente no código) em todas as interpolações de nome de tabela no endpoint de cleanup; adicionar teste unitário para a função validadora.

### PR-A7 — Substituir `setTimeout` fire-and-forget na entrega de mídia (dev-back)
**Achado:** `bots/teste_vendas.ts:306` e equivalente em `teste_vendas_barbearia` — entrega de mídia via `setTimeout` sem tratamento de erro; falha silenciosa.
**Escopo:** trocar `setTimeout` por `await` com try/catch explícito e log de erro; se BullMQ não estiver disponível (aguarda ADR da Missão 015), usar Promise com timeout e retry simples (máx. 2 tentativas).
**Restrição:** não depende de BullMQ; solução deve funcionar sem o worker.

## Definition of Done (DoD)

- [ ] A1: `npm test` na branch `feat/pairing-code-waha` passa sem failures
- [ ] A8: disco VPS abaixo de 60 GB após limpeza; log de o que foi removido documentado
- [ ] A2: `gcal_credentials_json` criptografado em repouso; coluna antiga zerada; chave via env
- [ ] A3: startup do painel falha explicitamente se `ADMIN_PASS` não estiver no env
- [ ] A4: script de backup executado com sucesso ao menos 1 vez; commit visível no repo privado
- [ ] A5: `GET /api/leads?page=2` retorna registros corretos (validado por tester com dados reais)
- [ ] A6: endpoint de cleanup rejeita qualquer nome de tabela não listado na whitelist
- [ ] A7: log de erro aparece quando entrega de mídia falha (validado em staging)
- [ ] Build local passa (`npm run build --workspaces`) após cada PR
- [ ] Tester rodou checklist de regressão em cada PR antes de abrir para review
- [ ] Cada PR mergeada individualmente pelo Bruno
- [ ] Deploy validado em produção após cada merge

## Fora de escopo

- Migrar painel para chamar API (Missão 014/ADR)
- Mover mídia para BullMQ real (depende de ADR — Missão 015)
- Redesign da tela de leads
- Criptografia de outros campos no banco além de `gcal_credentials_json`

## Dependências

- **A1:** nenhuma (executa primeiro)
- **A8:** Missão 011 entregue e lista aprovada pelo Bruno
- **A2/A3:** A1 mergeado (para não commitar em branch bloqueada)
- **A4:** A8 concluída + repo Git privado criado pelo Bruno
- **A5/A6/A7:** A1 mergeado

## Riscos

- **A2 — migration falha em prod:** mitigação: script idempotente testado em staging com dump real; rollback é `DROP COLUMN gcal_credentials_json_enc` (sem perda de dados — coluna original intacta até migração completa)
- **A8 — limpeza remove arquivo necessário:** mitigação: lista revisada pelo Bruno antes de qualquer `rm`; snapshot de disco antes da limpeza
- **A5 — mudança na paginação quebra frontend:** mitigação: grep obrigatório em `index.html` + smoke test de leads no painel após deploy
- **A7 — await em produção causa timeout:** mitigação: timeout explícito de 10s; fallback de log sem bloquear o fluxo do bot

## Plano de quebra

1. **012-A1:** Fix mock router tests — dev-back (PR pequena, imediata)
2. **012-A8:** Limpeza disco VPS — infra (depende de Missão 011)
3. **012-A2:** Criptografia gcal_credentials_json — dev-back (PR média)
4. **012-A3:** Remover default admin:admin — dev-back (PR pequena)
5. **012-A4:** Script backup Postgres — infra (PR pequena)
6. **012-A5:** Corrigir paginação leads — dev-back (PR média)
7. **012-A6:** safeTableName no cleanup — dev-back (PR pequena)
8. **012-A7:** Substituir setTimeout mídia — dev-back (PR pequena)

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria completa de 2026-05-19
