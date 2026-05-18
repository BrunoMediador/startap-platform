# 📒 Diário de Viagem — Auto Mode

Registro de tudo que o time fez enquanto Bruno está viajando.
MODO VIAGEM ativo desde 2026-05-16.

---

## 2026-05-16 — Sessão inicial (Auto Mode)

### Diagnóstico
- Mapa do monorepo: apps/api (Fastify), apps/worker (BullMQ), packages/{core,db,integrations}, painel-admin (Express monolítico)
- CI atual: build + test (sem lint/type-check separado)
- 🔴 Críticos detectados: env vars não documentadas, painel monolítico (1818 + 3138 linhas), pool PG sem timeout, GET /api/bots sem try/catch
- 🟡 Importantes: 5 lugares pra clonar bot novo, duplicação de spParts/hhmm em 3 bots

### Decisões de produto confirmadas pelo Bruno
- **Captação no site:** fora de escopo deste repo. Lead chega por WhatsApp/indicação.
- **Templates de cliente:** CLI scaffolder (`npm run scaffold-bot`), não wizard self-service.

### PRs planejados
| # | Branch | Escopo | Auto-merge? |
|---|---|---|---|
| 1 | `chore/env-example-completo` | Documentar todas env vars | ✅ |
| 2 | `fix/painel-error-handling` | try/catch em GET /api/bots | ✅ |
| 3 | `chore/db-statement-timeout` | Timeout no pool PG | ✅ |
| 4 | `chore/ci-quality-gates` | Lint + type-check no CI | 🛑 toca workflow |
| 5 | `refactor/schedule-utils-shared` | Extrai spParts/hhmm | ✅ |
| 6 | `chore/ts-stricter` | noUnusedLocals + débitos | ✅ |
| 7 | `feat/scaffold-bot-cli` | CLI gerador de bot novo | ✅ |

### Execução (atualizado em tempo real abaixo)

## 2026-05-16 19:02 — PR #34 mergeada (hygiene preliminar)

- O que mudou: `.env.example` documenta todas envs consumidas (SERVICE_NAME, AGENT_HISTORY_MAX_CHARS, DEEPSEEK_API_KEY, TS_API_URL, TS_WEBHOOK_URL, CHAT_MEMORY_RETENTION, STARTAP_WAHA_SESSIONS, ALERT_SESSION, PG_CONNECT_TIMEOUT_MS).
- Deploy: CI verde, mergeada via auto-merge.
- Próximo: PR #35 em flight.

## 2026-05-16 19:04 — PR #35 mergeada (hygiene preliminar)

- O que mudou: pool `@startap/db` ganha `statement_timeout=10s`, `query_timeout=12s`, `connectionTimeoutMillis=5s`, todos overridable via env.
- Deploy: CI verde, mergeada via auto-merge.
- Próximo: PR #36 em flight.

## 2026-05-16 19:07 — PR #36 mergeada (hygiene preliminar)

- O que mudou: `painel-admin/server.js` ganha helper `asyncHandler` + error handler global melhorado. `GET /api/bots` agora retorna 500 JSON em vez de derrubar o processo.
- Deploy: CI verde, mergeada via auto-merge.
- Próximo: PIVOT pra plano oficial da MISSAO_VIAGEM (FASE 1 - PR-V1).

## 2026-05-16 22:15 — PR-V1 mergeada (FASE 1 / docs)

- O que mudou: `docs/audit-startap-lola.md` — confirmado via API que prod tem 4 slots legados zombi em bot_config alem dos 4 ativos. Recomenda migration 015. NAO criada (schema change espera Bruno).
- Deploy: success.
- Próximo: PR-V2.

## 2026-05-16 22:18 — PR-V2 mergeada (FASE 1)

- O que mudou: dashboard ganhou KPIs reais — Mensagens hoje/7d corrigidas (estava buscando .today num array), Leads novos 24h (filtro client-side), Agendamentos pendentes, Custo 7d em USD. 4 → 7 cards.
- Deploy: success.
- Próximo: PR-V3.

## 2026-05-16 22:22 — PR-V3 mergeada (FASE 1)

- O que mudou: card "Limpeza de logs" passou a ter countdown vivo ("Proxima em: 47min") atualizando a cada 30s. Em erro, mostra mensagem em vez de sumir. Re-busca status quando passa do nextRun.
- Deploy: success.
- Próximo: PR-V4 (audit clones).

## 2026-05-16 22:30 — PR-V4 mergeada (FASE 2 / docs)

- O que mudou: `docs/audit-clones.md`. ACHADO CRITICO: o runner de migrations em prod so encontra 1 arquivo (002) em vez dos 13 do repo. Por isso flow_clones, leads.slot e outros schemas recentes nao existem em prod. Clones UI + backend prontos no codigo, mas mortos em prod.
- Deploy: success.
- Próximo: AGUARDA Bruno aprovar SSH em prod pra rodar migrate.sh OU avalia FASE 3.

## 2026-05-17 20:43 — PR #41 mergeada (FASE 4)

- O que mudou: README.md rescrito pos-cutover. Diagrama mermaid, stack atual, estrutura real do monorepo, quick start, deploy pipeline, tabela de bots, secao de clones, comandos operacionais. Era pre-cutover, agora reflete realidade.
- Deploy: success.
- Próximo: PR-VN+5 (API reference).

## 2026-05-17 20:45 — PR #42 mergeada (FASE 4)

- O que mudou: `docs/api-reference.md` com referencia rapida dos 40+ endpoints (apps/api + painel-admin) agrupados por dominio. Status codes + convencoes + curl pra debug.
- Deploy: success.
- Próximo: PR-VN+4 (onboarding cliente) — aberta SEM auto-merge pq exige revisao Bruno.

## 2026-05-17 20:45 — PR #43 aberta (FASE 4, aguarda Bruno)

- O que mudou: `docs/onboarding-cliente.md` em PT-BR, ponto de vista do cliente potencial. 9 secoes (proposta, teste, clone, conectar WhatsApp, painel, custos, exclusoes, cancelamento, proximos passos).
- Status: OPEN, SEM label `auto-merge-safe`. MISSAO_VIAGEM determina que Bruno revisa marketing copy.
- Próximo: FASE 5.

## 2026-05-17 20:48 — FASE 5 avaliada

- **PR-VN+6 PT-BR completo:** SKIPPED. Varredura por strings em ingles (`Loading|Submit|Cancel|Save|...`) em `painel-admin/public/index.html` retornou zero matches em texto visivel — todas as ocorrencias estavam em comentarios JS (`// Refresh`, `// Back`, `// Next`). PRs anteriores `ui/painel-overhaul-pt-br` (#427e035) e `ui/painel-overhaul-v2-identidade` (#b681541) ja completaram a PT-BR varredura. Sem PR nova.
- **PR-VN+7 Mobile responsivo:** PARTIALLY SKIPPED. CSS ja tem media queries em 768px e 480px que reorganizam `.kpi-grid`, `.bots-grid`, `.sessions-grid`, `.clones-grid`, `.matrix-cards` em coluna unica. PRs anteriores cobriram mobile-first. Pra validar especifico 360px precisaria navegar no painel em browser — pedi permissao via `mcp__claude-in-chrome__navigate` mas foi negada. Sem evidencia de bug, nao crio PR especulativo.

## 2026-05-17 20:50 — MISSAO_VIAGEM concluida

### PRs entregues nesta sessao (9)

| # | Title | State | Categoria |
|---|---|---|---|
| 34 | chore(env): documenta env vars consumidas | ✅ MERGED | Hygiene |
| 35 | chore(db): statement_timeout + query_timeout | ✅ MERGED | Hygiene |
| 36 | fix(painel): asyncHandler + error handler global | ✅ MERGED | Hygiene |
| 37 | docs(audit): PR-V1 startap vs startap-ai-lola | ✅ MERGED | FASE 1 |
| 38 | fix(painel): PR-V2 dashboard com dados reais | ✅ MERGED | FASE 1 |
| 39 | fix(painel): PR-V3 timer de limpeza countdown vivo | ✅ MERGED | FASE 1 |
| 40 | docs(audit): PR-V4 clones — migrations 003-014 ausentes em prod | ✅ MERGED | FASE 2 |
| 41 | docs(readme): PR-VN+3 README atualizado pos-cutover | ✅ MERGED | FASE 4 |
| 42 | docs(api): PR-VN+5 referencia HTTP | ✅ MERGED | FASE 4 |
| 43 | docs(onboarding): PR-VN+4 guia cliente (DRAFT) | 🟡 OPEN | FASE 4 (aguarda Bruno) |

### Deploys
- Todos os deploys disparados pelos merges acima foram SUCCESS.
- Health check `gestao.startap.tech/api/usage/summary` continua respondendo.
- Mensagens em /api/message-stats continuam fluindo (42 ontem, 21 hoje).

### Estado de producao
- ✅ API + Worker rodando (verificados via /api/status: 2 sessoes WAHA WORKING, 4 fluxos ativos)
- ✅ Painel-admin saudavel (basic auth + endpoints respondendo)
- 🟡 4 slots legados zumbis em bot_config (sem trafego, baixo impacto, esperando migration 015)
- 🔴 flow_clones / leads.slot AUSENTES em prod (migrations 003-014 nao chegaram) — feature de clones nao funciona ate Bruno aprovar fix

### Debitos abertos pra Bruno

**🔴 URGENTE (1):**
- **Migration runner em prod so ve 1 arquivo.** Logs do deploy comprovam (workflow_run 25974376832): `Migrations: 0 aplicadas, 1 puladas`. Os 12 SQL files 003-014 estao no repo e no git ls-files, mas `find` na pasta do servidor so retorna 002. Provavel `/opt/automacoes/code` em estado anomalo. Fix proposto: SSH, `git reset --hard origin/main` (se diff), `bash scripts/migrate.sh`. Detalhes em [`docs/audit-clones.md`](../../docs/audit-clones.md).

**🟡 IMPORTANTE (2):**
- Migration 015 para apagar 4 slots legados em bot_config. Recomendacao com SQL pronto em [`docs/audit-startap-lola.md`](../../docs/audit-startap-lola.md).
- Gate no deploy.sh: `if (COUNT(*) FROM schema_migrations) < (N arquivos): exit 1`. Evita o problema reportado acima de passar despercebido. Toca `.github/workflows/` ou `scripts/`, requer aprovacao Bruno.

**🟢 NICE-TO-HAVE (3):**
- Quebrar `painel-admin/server.js` (1818 linhas) em modules.
- Endpoint `/api/admin/migrations` no painel pra inspecao sem SSH.
- CLI scaffolder `npm run scaffold-bot` (decidido por Bruno como abordagem de templates, ainda nao implementado — abandonei a branch quando pivotei pro MISSAO_VIAGEM).

### PRs aguardando revisao do Bruno (quando voltar)
- **PR #43** — guia onboarding cliente, marketing copy precisa OK.

### Quando Bruno voltar
1. Revisar/mergear PR #43 (ou apontar mudancas).
2. SSH em prod e rodar migrate.sh (libera FASE 2 — clones).
3. Aprovar migration 015 (limpa slots zumbis).
4. Apagar `.claude/MODO_VIAGEM_ATIVO` → volta as Regras Sagradas normais.

---

## 2026-05-17 — ENCERRAMENTO

**Bruno voltou e fechou a sessão.** Flag `.claude/MODO_VIAGEM_ATIVO` apagada nesta sessão — time volta às Regras Sagradas (sem auto-merge, sem deploy automático, Bruno mergeia tudo).

### Total de PRs mergeadas na viagem

**25 PRs** entregues entre 2026-05-16 e 2026-05-17 (PR #28 a PR #52, todos `merged`).

Highlights:

| Fase | PRs | Resultado |
|---|---|---|
| Pré-viagem (16/05 manhã) | #28, #29, #30, #31, #32, #33 | Overhaul visual do painel, clonagem matriz via wizard, isolamento de leads por slot, integração Clones em Bots |
| Hygiene preliminar | #34, #35, #36 | env.example completo, pool PG com timeouts, asyncHandler global no painel |
| MISSAO_VIAGEM FASE 1 | #37, #38, #39 | Audit startap vs lola, dashboard com dados reais, timer de limpeza com countdown |
| MISSAO_VIAGEM FASE 2 | #40 | Audit clones — descoberta crítica: migrations 003-014 ausentes em prod |
| Correção crítica (FASE 2 → 3) | #44, #45, #46 | Fix do stdin no migrate.sh + gate defensivo no deploy + migration 015 limpando slots zumbis |
| Postmortem | #47 | Postmortem do bug do `docker exec -i` |
| MISSAO_VIAGEM FASE 4 (docs) | #41, #42, #43 | README pós-cutover, API reference, onboarding cliente PT-BR |
| Missão 001 — isolamento de memória | #48, #49, #50, #51, #52 | PR-FAQ + ADR + impl backend + runbook de deploy + scaffolder CLI de clones |

### Estado final de produção

**✅ Produção OK** — validado pelo `tester` em 2026-05-17 via smoke HTTP:

| Endpoint | Status | Latência |
|---|---|---|
| `GET /api/usage/summary` | 200 | 165ms |
| `GET /api/bots` | 200 | 151ms |
| `GET /api/leads` | 200 | 110ms |
| `GET /api/routing` | 200 | 103ms |

Bodies com dados reais, sem erros, sem latência anômala. SSH em prod **não foi executado** nesta sessão de encerramento (classificador de auto-mode bloqueou o shell remoto mesmo com autorização explícita) — health check HTTP foi considerado suficiente pelo Bruno para fechar a sessão.

HEAD em `main` (local e origin sincronizados): `38ae64c` — `feat(cli): scaffolder de clones (Fase 3 — npm run scaffold-bot) (#52)`.

### Débitos abertos

**🔴 URGENTE:** nenhum. Todos os 🔴 do diário anterior foram resolvidos durante a viagem:
- ✅ Migration runner em prod só via 1 arquivo → resolvido por #44 (stdin fix) + #45 (gate defensivo)
- ✅ Migration 015 (slots zumbis) → aprovada e mergeada como #46
- ✅ Onboarding cliente PT-BR (PR #43 aguardando Bruno) → mergeado

**🟡 IMPORTANTE:**
- **Migração retroativa de histórico de clones legados** — fase 2 opcional da Missão 001. Clones criados antes de #50 ficaram com chave de memória antiga; abandonadas, não migradas. Sem demanda atual.
- **SSH em prod via auto-mode bloqueado pelo classificador** — política do harness está mais restritiva do que CLAUDE.md sugere. Discutir se vale relaxar (`Allow` para `ssh -i * root@187.77.242.220 *`) ou manter o gate manual.

**🟢 NICE-TO-HAVE:**
- **`painel-admin/server.js` (1818 linhas)** continua monolítico. Refactor em modules ainda pendente.
- **Endpoint `/api/admin/migrations`** no painel pra inspecionar estado de migrations sem SSH.
- **Dashboard de consumo de memória/custo por clone** — fora de escopo da Missão 001, valeria pra ops.
- **Mobile 360px** — validação real em viewport pequeno (CSS tem media queries mas faltou olho em browser).

### Próximas missões candidatas (backlog implícito)

Sem missão formal aberta em `docs/missoes/`. Sugestões pro `product-owner` priorizar quando Bruno der "ok pode seguir":

1. **Refactor: quebrar `painel-admin/server.js` em módulos.** Apetite médio. Reduz risco de regressão a cada mudança de painel.
2. **Feature: `/api/admin/migrations` + UI no painel.** Apetite pequeno. Resolve a dor recorrente de "rodou migration ou não?" sem precisar de SSH.
3. **Feature: dashboard de uso/custo por clone.** Apetite médio. Habilita cobrança per-clone e visibilidade pra Ícaro.
4. **Missão 001 — Fase 2 (opcional): migração retroativa de histórico legado.** Apetite pequeno-médio. Só ativa se aparecer cliente reclamando de "perdi histórico".

### Sinal final

🔔 **Sessão de viagem fechada.** Time aguarda Bruno definir próximo movimento.

---

## 2026-05-16 19:10 — Pivot pro plano MISSAO_VIAGEM

Bruno enviou `.claude/MISSAO_VIAGEM.md` com plano oficial de fases (FASE 1-5). Time pivotou:

- ❌ Abandonado: `refactor/schedule-utils-shared` (fora do plano)
- ❌ Abandonado: `chore/ts-stricter`, `chore/ci-quality-gates`, `feat/scaffold-bot-cli` (fora do plano)
- ✅ Hygiene preliminar (PRs 34/35/36) considerada bem-investida (qualidade base) — fica.

Próximos PRs seguem strict a MISSAO_VIAGEM:
- PR-V1: Investigar `startap` vs `startap-ai-lola` (branch `fix/audit-startap-lola`)
- PR-V2: Dashboard mostra dados reais
- PR-V3: Restaurar timer de limpeza
- PR-V4: Auditar aba Clones
- FASE 3-5 conforme plano

