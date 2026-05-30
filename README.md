# Startap Platform

Plataforma TypeScript de bots WhatsApp via WAHA. Atende clientes reais (barbearias, cursos de barbeiro, prospecção interna) com bots IA, agenda no Google Calendar, captura de leads e um painel admin único.

> **Status:** ✅ produção desde 2026-05-14 — cutover do automação visual antiga concluído.
> **Painel:** https://gestao.startap.tech
> **Server:** Hostinger VPS `187.77.242.220` (Docker compose, deploy automatizado via GitHub Actions)

📘 [CONTRIBUTING.md](./CONTRIBUTING.md) — fluxo de PR + deploy
📋 [CUTOVER.md](./CUTOVER.md) — histórico da migração
📐 [docs/platform-architecture.md](./docs/platform-architecture.md), [data-model.md](./docs/data-model.md), [operations-runbook.md](./docs/operations-runbook.md), [conversation-scope.md](./docs/conversation-scope.md)
🔍 Auditorias recentes: [audit-startap-lola.md](./docs/audit-startap-lola.md), [audit-clones.md](./docs/audit-clones.md)

---

## O que faz

- Recebe webhooks WAHA (`/webhooks/waha`) e roteia cada mensagem para o **bot certo** com base na sessão WhatsApp + telefone.
- Cada bot atende um fluxo de negócio (`teste_barbearia`, `teste_vendas`, `teste_vendas_barbearia`, `startap`). Os 3 primeiros são **matrizes** que podem ser **clonadas** por cliente — cada clone tem sessão WAHA dedicada e prompt customizado.
- Workers em background fazem antibot, limpeza de histórico, alertas.
- Painel admin permite: editar prompt do bot, subir mídias, criar/clonar bots, ligar sessão WAHA, ver leads/agendamentos, monitorar custo de IA.

## Arquitetura

```mermaid
flowchart LR
  subgraph WhatsApp
    U[Usuário]
  end
  subgraph WAHA["WAHA (whatsapp engine)"]
    S1[Sessão STARTAP_AI_PROD]
    S2[Sessão WHATSAPP_ROUTER_TESTE]
    SC[Sessões por clone]
  end
  subgraph API["apps/api · Fastify"]
    WH[POST /webhooks/waha]
    R[Router]
    B1[startap bot · Lola]
    B2[teste_barbearia]
    B3[teste_vendas]
    B4[teste_vendas_barbearia]
    BC[Clone bots — herdam matriz]
  end
  subgraph WK["apps/worker · BullMQ + Croner"]
    J1[antibot · 1min]
    J2[cleanup-chat · 1h]
  end
  subgraph DB[(Postgres)]
    T1[bot_config / bot_prompt / bot_media]
    T2[flow_clones · flow_pauses · flow_pause_keywords]
    T3[flow_execution_logs · model_usage]
    T4[leads_* · agendamento_pendente]
  end
  subgraph EXT["Integrações externas"]
    OAI[OpenAI / DeepSeek]
    WHISP[Whisper local]
    GCAL[Google Calendar]
  end
  subgraph Admin["painel-admin · Express"]
    P[gestao.startap.tech]
  end

  U --> WAHA
  WAHA -- webhook --> WH
  WH --> R
  R --> B1 & B2 & B3 & B4 & BC
  B1 & B2 & B3 & B4 & BC --> WAHA
  B1 & B2 & B3 & B4 & BC --> OAI
  B1 & B2 & B3 & B4 & BC --> WHISP
  B2 & B3 & B4 & BC --> GCAL
  B1 & B2 & B3 & B4 & BC --> DB
  WK --> DB
  WK --> WAHA
  P --> DB
  P --> API
```

## Stack

| Camada | Escolha |
|---|---|
| Runtime | Node.js 20 LTS |
| Linguagem | TypeScript 5 (ESM, `strict: true`) |
| HTTP | Fastify 5 + zod |
| Worker | BullMQ + croner + Redis 7 |
| DB | Postgres 15 + `pg` (queries cruas, tipadas) |
| IA | `openai` SDK (tool-calling). DeepSeek opcional via mesma interface. |
| Transcrição | Whisper ASR self-hosted (`:9000/asr`) |
| Calendar | Google Calendar OAuth2 (refresh token) |
| Logs | pino JSON estruturado |
| Linter/Format | biome |
| Testes | vitest |
| Painel admin | Express 4 + Multer + Vanilla JS/HTML |
| Build & Deploy | Docker compose + GitHub Actions (CI + deploy SSH) |

## Estrutura do monorepo

```
startap-platform/
├── apps/
│   ├── api/                  # Fastify — webhooks WAHA, registry de bots
│   │   └── src/
│   │       ├── server.ts     # entry
│   │       ├── router.ts     # roteia sessão+telefone → bot
│   │       ├── registry.ts   # registra bots e clones
│   │       ├── routes/       # health, webhook-waha
│   │       ├── bots/         # startap, teste_barbearia, teste_vendas, teste_vendas_barbearia, echo
│   │       └── lib/          # run-agent, render-prompt, etc
│   └── worker/               # BullMQ jobs (antibot, cleanup-chat)
│       └── src/
│           ├── worker.ts
│           └── jobs/*.ts
├── packages/
│   ├── core/                 # tipos + utils (phone, logger, types)
│   ├── db/                   # client + queries por dominio
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   └── queries/      # agendamento, antibot, bot-config, bot-media, bot-prompt, chat-memory, flow-clones
│   │   └── migrations/       # *.sql idempotentes aplicadas por scripts/migrate.sh
│   └── integrations/         # clientes externos (waha, openai, whisper, google-calendar)
├── painel-admin/             # Express + HTML único — admin UI
│   ├── server.js
│   └── public/index.html
├── scripts/                  # deploy.sh, migrate.sh, seed-prompts.mjs
├── docs/                     # arquitetura, runbook, auditorias
├── .github/workflows/        # ci.yml, deploy.yml, cleanup-stale-branches.yml, backup-postgres.yml
├── docker-compose.yml
├── Dockerfile
├── biome.json
└── tsconfig.base.json
```

## Quick start (local)

Pré-requisitos: Node 20+, Docker, Postgres acessível (local ou remoto), conta WAHA com API key.

```bash
git clone https://github.com/BrunoMediador/startap-platform.git
cd startap-platform
npm install
cp .env.example .env
# preencher PG_*, WAHA_URL, WAHA_API_KEY, OPENAI_API_KEY

# build de todos os workspaces
npm run build --workspaces --if-present

# subir o painel admin local (porta 3030)
node painel-admin/server.js
# abre http://localhost:3030  (admin / startap2026)

# subir API em watch (porta 3040)
cd apps/api && npm run dev

# subir worker em watch
cd apps/worker && npm run dev
```

## Variáveis de ambiente

Todas as envs consumidas pelo código estão em [.env.example](./.env.example) com comentário do componente que usa e o default. Resumo das obrigatórias:

| Var | Componente | Obs |
|---|---|---|
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASS` / `PG_DB` | Pool Postgres (api, worker, painel) | Pool tem `statement_timeout=10s` e `query_timeout=12s` por padrão. |
| `WAHA_URL` / `WAHA_API_KEY` | Integração WAHA | URL interna do container WAHA + API key. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Agente IA | Default `gpt-4o-mini`. |
| `DEEPSEEK_API_KEY` | Provider alternativo | Opcional, ativado por config de bot. |
| `WHISPER_URL` | Transcrição áudio | Container Whisper interno. |
| `GOOGLE_OAUTH_*` | Google Calendar | Opcional, só pra bots com agenda. |
| `ADMIN_USER` / `ADMIN_PASS` | Basic auth do painel | Trocar em produção. |
| `STARTAP_WAHA_SESSIONS` | Lista CSV de sessões do bot Lola | Default `startap`. |

Veja `.env.example` para a lista completa (incluindo opcionais).

## Deploy

Automatizado via GitHub Actions. Fluxo:

1. **Branch → PR → CI** (`.github/workflows/ci.yml`): `npm ci` + `npm run build --workspaces`.
2. **Merge na main → CI roda de novo → Deploy** (`deploy.yml`): SSH no servidor e executa `bash scripts/deploy.sh`.
3. **deploy.sh**:
   - `git pull --rebase origin main`
   - `docker compose build --no-cache`
   - `bash scripts/migrate.sh` (aplica migrations idempotentes ainda não registradas em `schema_migrations`)
   - `docker compose up -d` (api, worker)
   - Re-builda painel-admin na stack pai (`/opt/automacoes/docker-compose.yml`)
   - Health checks em api + painel-admin

Concorrência de deploys serializada (`concurrency: deploy-prod`). Deploy nunca aborta no meio — enfileira.

Rollback manual: revert do commit ruim na main → CI → deploy. Detalhes em [CONTRIBUTING.md](./CONTRIBUTING.md).

## Bots em produção

| slot | matriz | sessão WAHA | role |
|---|---|---|---|
| `startap` | — (interno) | `startap` / `STARTAP_AI_PROD` | Prospecção comercial Startap (Lola) |
| `teste_barbearia` | matriz | `WHATSAPP_ROUTER_TESTE` | Atendimento + agenda de barbearia |
| `teste_vendas` | matriz | `WHATSAPP_ROUTER_TESTE` | Venda do curso de barbeiro (Ricardo) |
| `teste_vendas_barbearia` | matriz | `WHATSAPP_ROUTER_TESTE` | Proposta mista: vende curso + agenda barbearia |

**Matrizes** (`teste_*`) podem ser **clonadas** via painel para criar instâncias por cliente. Cada clone tem sessão WAHA dedicada, prompt próprio, leads isolados (`leads_*.slot`).

## Clones por cliente

- Wizard de clonagem em **Painel → Bots → Clonar este** (em cada matriz).
- Backend: `packages/db/migrations/013_flow_clones.sql` cria `flow_clones`. Tabela já tem `slot` (PK), `matriz_slot`, `display_name`, `cliente_*`, `personalizacao` (JSONB), `waha_sessao`, `status`.
- Roteamento usa `waha_sessao` (não telefone) — múltiplos clientes com mesmo telefone em sessões diferentes funcionam.
- Leads ficam isolados por `slot` (PR #32).

### Suspender fluxo sem desconectar WhatsApp (migration 038)

`flow_clones` ganhou `flow_enabled boolean DEFAULT true`. Quando `false`, o router silencia o bot completamente (sem resposta ao cliente) mas a sessão WAHA permanece conectada — ao reativar, basta 1 clique, sem novo QR/pairing.

- **Painel admin**: `POST /api/clones/:id/suspend` (body `{ reason? }`) e `POST /api/clones/:id/resume`.
- **Auditoria**: toda ação registrada em `flow_suspension_log` (actor = userId da sessão admin).
- **Rollback**: revert PR + `prisma migrate resolve` não se aplica (sem ORM). SQL de rollback está no cabeçalho de `038_flow_enabled.sql`.

## Operações

Veja [docs/operations-runbook.md](./docs/operations-runbook.md). Resumo:

```bash
# Health prod
curl -u admin:startap2026 https://gestao.startap.tech/api/usage/summary
curl -u admin:startap2026 https://gestao.startap.tech/api/status

# SSH no servidor
ssh -i ~/.ssh/hostinger_codex_ed25519 root@187.77.242.220 -p 22

# Containers
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# Logs
docker logs startap-api -f
docker logs startap-worker -f

# Re-rodar migrations (idempotente)
cd /opt/automacoes/code && bash scripts/migrate.sh
```

## Decisões arquiteturais

- **Sem ORM**: queries cruas com `pg`. Wrapper fino para type safety. Migrations idempotentes via `scripts/migrate.sh`.
- **Sem LangChain**: orquestração própria em `packages/integrations/openai/agent.ts`. Loop tool-calling explícito.
- **Bots como classes**: `BotBase` centraliza pausa, memória, envio. Cada bot só implementa `process()`.
- **Router universal**: 1 endpoint `/webhooks/waha` para todas as sessões. Roteamento por `body.session` + lookup em `bot_config` / `flow_clones`.
- **Antibot no router**: bloqueio global aplicado antes de qualquer bot.
- **Clones por sessão WAHA**: cada clone bind uma sessão dedicada — sem conflito de telefone.
- **Painel single-page**: Vanilla JS num único `public/index.html` para não introduzir build de frontend. Pragmático.

## Licença

Privado. Todos os direitos reservados a Bruno Mediador / Startap.
