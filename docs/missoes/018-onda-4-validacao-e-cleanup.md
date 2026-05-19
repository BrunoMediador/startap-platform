# Missão 018 — Onda 4: Validação e cleanup (D1-D14)

**DRI:** distribuído — tester (D1-D3), dev-back (D4-D10, D14), dev-front (D12), infra (D5, D6, D13)
**Agentes envolvidos:** tester, dev-back, dev-front, infra, gerente-pr
**Apetite:** grande (até 5 dias úteis, ~1 semana)
**Status:** pendente
**Cliente (persona):** time técnico (qualidade e segurança) + Bruno (visão operacional mais segura do painel)
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (débitos técnicos de qualidade e cleanup)

---

## Contexto

A auditoria de 2026-05-19 identificou 14 itens de qualidade, segurança e limpeza que não são bloqueadores críticos mas acumulam dívida técnica e risco operacional. Esta missão cobre: exclusão fantasma de testes (D1), checklist de regressão (D2), teste do endpoint de pairing code (D3), centralização de envs (D4), senha do Redis (D5), correção do trigger de CI (D6), postmortems pendentes (D7), segurança de mídia (D8), limpeza de tabela de pausa legada (D9), safeTableName no worker (D10), pricing pendente de revisão (D11), mobile da tabela de cursos (D12), status check obrigatório no pairing code (D13) e plano de migração de tabelas legadas de pausa (D14). Cada item é uma PR pequena. A missão pode começar em paralelo com a Onda 3, mas a maioria dos itens requer que as Ondas 1 e 2 tenham sido mergeadas.

## Restrições críticas

- D9 e D14 (limpeza de tabelas de pausa): sem DROP/DELETE; plano de migração revisado pelo Bruno antes de qualquer execução
- D5 (Redis requirepass): mudança de configuração do Redis requer restart do container; coordenar com infra para janela de manutenção
- D7 (postmortems): documentação obrigatória — não pode ser pulado

## Sub-missões / PRs

### PR-D1 — `vitest.config.ts` excluir worktrees Claude (tester + dev-back)
**Achado:** worktrees em `.claude/worktrees/**` geram 69 test failures fantasma.
**Escopo:** adicionar `exclude: ['.claude/worktrees/**']` no `vitest.config.ts`; confirmar que `npm test` retorna apenas failures reais.

### PR-D2 — Criar `docs/regressao.md` (tester)
**Achado:** ausência de checklist formal de regressão; cada tester improvisa o escopo.
**Escopo:** criar `docs/regressao.md` com checklist mínimo verificável: endpoints críticos, bots em prod, painel (abas principais), casos de borda conhecidos (pausa, GCal, pairing code). Máximo 2 páginas.

### PR-D3 — Teste unitário para `POST /api/sessions/:name/pairing-code` (tester + dev-back)
**Achado:** endpoint criado na Missão 010 sem teste unitário.
**Escopo:** adicionar teste em `apps/api/src/router.test.ts` (ou `painel-admin/`) cobrindo: resposta 200 com código válido, 409 (sessão já conectada), 400 (telefone inválido), 502 (WAHA indisponível).

### PR-D4 — Centralizar variáveis de ambiente com schema Zod (dev-back)
**Achado:** `DEEPSEEK_API_KEY`, `STARTAP_WAHA_SESSIONS` e outras envs espalhadas sem validação central.
**Escopo:** criar `packages/config/src/env.ts` com schema Zod que valida todas as envs no startup; falhar explicitamente com mensagem clara se env obrigatória estiver ausente; atualizar `.env.example`.

### PR-D5 — Redis `requirepass` no compose (infra)
**Achado:** Redis no `docker-compose.yml` sem autenticação.
**Escopo:** adicionar `requirepass` via variável de ambiente `REDIS_PASSWORD` no compose; atualizar clientes Redis na aplicação para enviar a senha; atualizar `.env.example`; testar que BullMQ e outros consumers Redis continuam funcionando.

### PR-D6 — Corrigir trigger `check_suite: completed` no `auto-merge.yml` (infra)
**Achado:** `.github/workflows/auto-merge.yml` tem trigger `check_suite: completed` que não funciona corretamente com GitHub Actions (evento não dispara como esperado).
**Escopo:** corrigir para usar `workflow_run: completed` ou `pull_request: synchronize` + `check_run: completed` conforme a documentação atual do GitHub Actions; testar em branch de sandbox antes de mergear.

### PR-D7 — Postmortems 2026-05-17 e 2026-05-18 (infra)
**Achado:** incidentes dos dias 17 e 18/05 sem postmortem formal; ações pendentes não rastreadas.
**Escopo:** criar `docs/postmortems/2026-05-17-*.md` e `docs/postmortems/2026-05-18-*.md` seguindo template; identificar ações pendentes e criar itens correspondentes nesta missão ou em missões específicas.

### PR-D8 — `DELETE /api/media/:id` verificar `slot` (dev-back)
**Achado:** `server.js:1061` — endpoint de deleção de mídia não verifica se a mídia pertence ao slot do usuário autenticado.
**Escopo:** adicionar `WHERE slot = $slot AND id = $id` na query de DELETE de mídia; retornar 404 se mídia não pertencer ao slot; adicionar teste.

### PR-D9 — Limpeza da tabela `bot_pausa` legada (dev-back)
**Achado:** tabela `bot_pausa` com dados antigos/legados.
**Escopo:** mapear quais slots ainda têm dados na tabela; criar migration que arquiva (não apaga) dados em tabela `bot_pausa_archive`; validar que nenhum código em prod lê de `bot_pausa` antes de executar; apresentar plano ao Bruno antes de executar migration.
**Restrição:** sem DROP ou DELETE; arquivamento via `INSERT INTO ... SELECT ... FROM`.

### PR-D10 — `safeTableName` no cleanup-chat worker (dev-back)
**Achado:** worker de cleanup usa interpolação de nome de tabela sem `safeTableName` (inconsistente com a correção A6 da Missão 012).
**Escopo:** aplicar a mesma função `safeTableName` no worker de cleanup; confirmar que tabelas legadas de n8n na whitelist continuam sendo limpas corretamente.
**Bloqueio:** A6 da Missão 012 deve estar mergeado primeiro para reusar a implementação.

### PR-D11 — Revisão periódica de pricing `gpt-5.4` (dev-back)
**Achado:** `packages/db/src/queries/model-usage.ts` pode ter custo estimado se OpenAI não publicou pricing oficial ainda.
**Escopo:** verificar se OpenAI publicou pricing oficial de `gpt-5.4`; se sim, atualizar com valor real e remover marca "estimado"; se não, criar issue/reminder para revisão em 30 dias.
**Nota:** pode ser uma atualização de 5 minutos ou uma nota documentada — proporcional à informação disponível.

### PR-D12 — Tabela de cursos responsiva em mobile <480px (dev-front)
**Achado:** `renderBotCourses` — grade de cursos sem media queries para telas menores que 480px.
**Escopo:** adicionar media queries em `index.html` para a tabela/grid de cursos; testar em 360px e 414px; sem redesign — só ajuste de layout para não quebrar.

### PR-D13 — Status check WAHA obrigatório no pairing code (dev-back)
**Achado:** `server.js:3511` — endpoint de pairing code não verifica se a sessão está em `SCAN_QR_CODE` antes de solicitar código ao WAHA.
**Escopo:** adicionar verificação de status antes de chamar WAHA; retornar 409 com mensagem clara se sessão não estiver em `SCAN_QR_CODE`; este comportamento foi documentado no DoD da Missão 010 mas implementado de forma opcional — tornar obrigatório.

### PR-D14 — Plano de migração das tabelas legadas `pause_*` (dev-back)
**Achado:** tabelas `pause_ricardo`, `pause_cirilo`, `pause_startap` são legadas de clientes n8n anteriores.
**Escopo:** mapear quais bots ainda dependem dessas tabelas (grep no código); criar documento `docs/historico/migracao-pause-legadas.md` com plano de migração para `bot_pausa`; apresentar plano ao Bruno antes de qualquer execução; NÃO executar a migração nesta missão — só o plano.
**Restrição:** esta PR entrega apenas documentação; a execução da migração é missão futura pós-aprovação do Bruno.

## Definition of Done (DoD)

- [ ] D1: `npm test` sem failures fantasma de worktrees
- [ ] D2: `docs/regressao.md` existe e tem pelo menos 10 itens verificáveis
- [ ] D3: 4 cenários de teste para pairing code passando
- [ ] D4: startup da API falha com mensagem clara se env obrigatória estiver ausente
- [ ] D5: Redis requer senha; BullMQ conecta sem erros após mudança
- [ ] D6: `auto-merge.yml` dispara corretamente em branch de teste
- [ ] D7: dois arquivos de postmortem criados em `docs/postmortems/`
- [ ] D8: `DELETE /api/media/:id` retorna 404 para mídia de outro slot
- [ ] D9: dados arquivados em `bot_pausa_archive`; plano aprovado pelo Bruno antes de executar
- [ ] D10: worker de cleanup usa `safeTableName`; cleanup continua rodando normalmente
- [ ] D11: pricing de `gpt-5.4` atualizado ou documentado como pendente com data de revisão
- [ ] D12: tabela de cursos não quebra em 360px (testado no Chrome DevTools)
- [ ] D13: endpoint retorna 409 se sessão não estiver em `SCAN_QR_CODE`
- [ ] D14: `docs/historico/migracao-pause-legadas.md` criado; nenhuma tabela alterada
- [ ] Build local passa após cada PR
- [ ] Tester validou cada PR
- [ ] Cada PR mergeada individualmente pelo Bruno
- [ ] Deploy validado após cada merge

## Fora de escopo

- Execução da migração de tabelas legadas (D14 — só o plano)
- Execução do arquivamento de `bot_pausa` (D9 — só plano + migration pronta)
- Paginação completa de leads (Missão 013)
- Refactor do painel (aguarda ADR da Missão 014)

## Dependências

- **D1:** nenhuma (imediato)
- **D2:** nenhuma (imediato)
- **D3:** Missão 012 PR-A1 mergeada (branch desbloqueada)
- **D4:** Missão 012 PR-A3 mergeada (para alinhar com remoção de defaults de env)
- **D5:** Missão 011 concluída (disco + infra estável)
- **D6:** nenhuma (CI é independente)
- **D7:** nenhuma (documentação)
- **D8:** Missão 012 PR-A1 mergeada
- **D9:** Missão 013 concluída (tabelas de dados corretos primeiro)
- **D10:** Missão 012 PR-A6 mergeada (`safeTableName` implementado)
- **D11:** nenhuma
- **D12:** nenhuma
- **D13:** Missão 012 PR-A1 mergeada
- **D14:** Missão 011 + mapeamento de tabelas legadas

## Riscos

- **D5 — Redis com senha quebra BullMQ em prod:** mitigação: testar em staging; rollback é remover `requirepass` e reiniciar
- **D9 — dados arquivados erroneamente:** mitigação: Bruno aprova o plano antes da execução; migration reversível (INSERT, não DELETE)
- **D14 — tabela legada ainda tem dependência escondida:** mitigação: grep completo antes de qualquer plano de migração

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria de 2026-05-19 identificar itens D1-D14
