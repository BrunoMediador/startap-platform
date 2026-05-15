# Startap Platform

Plataforma de bots WhatsApp para a Startap. **Migração do automação visual antiga para código TypeScript.**

> Status: ✅ Produção (2026-05-14) — 3 bots ativos.
>
> 📘 **Como contribuir**: [CONTRIBUTING.md](./CONTRIBUTING.md) — fluxo PR + deploy via `./scripts/deploy.sh`. 
> 📋 Estado do cutover: [CUTOVER.md](./CUTOVER.md)
> 🧭 Evolução da plataforma: [docs/platform-architecture.md](./docs/platform-architecture.md), [docs/conversation-scope.md](./docs/conversation-scope.md), [docs/data-model.md](./docs/data-model.md), [docs/operations-runbook.md](./docs/operations-runbook.md)

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                          WAHA                                │
│  (sessões startap, TESTE_STARTAP — WhatsApp engine)         │
└──────────────────────────┬──────────────────────────────────┘
                           │ webhook
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/api  (Fastify, TypeScript)                            │
│                                                              │
│  POST /webhooks/waha  ─→  Router  ─→  Bot.handle(ctx)       │
│                              │                               │
│                              ├─ extrai telefone (LID/PN)    │
│                              ├─ antibot + pausa global      │
│                              ├─ busca em routing_clientes   │
│                              └─ delega para Bot registrado  │
│                                                              │
│  Bots:                                                       │
│   • EchoBot (teste/template)                                 │
│   • BarbeariaBot     ← TESTE_BARBEARIAS_AGENDAMENTOS         │
│   • RicardoBot       ← elenildo.ricardo (TESTE_VENDAS_CURSO) │
│   • StartapMainBot   ← STARTTAP_AI (Lola)                   │
│   • StartapAdminBot  ← STARTTAP_AI (admin pausa Samuel)     │
└──────┬──────────────────────────────────────────────────────┘
       │
       ├─→  packages/integrations/waha       (sendText, typing, media)
       ├─→  packages/integrations/openai     (agent com tool-calling)
       ├─→  packages/integrations/whisper    (transcrição áudio)
       └─→  packages/integrations/google-calendar (agendamento)

┌─────────────────────────────────────────────────────────────┐
│  apps/worker  (cron jobs)                                   │
│                                                              │
│   • antibot         ← Monitor_AntiBot         (a cada 1min) │
│   • cleanup-chat    ← Limpar_Historico_Chat   (diário 03h)  │
│   • relatorio       ← RELATORIO_BARBEARIA_SAMUEL (em build) │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Postgres (compartilhado com automação visual antiga durante migração)          │
│   routing_clientes  •  pausa_*  •  chat_histories_*     │
│   message_log  •  bot_pausa  •  leads_ricardo  •  ...        │
└─────────────────────────────────────────────────────────────┘
```

---

## Stack

| Camada | Escolha |
|--------|---------|
| Runtime | Node.js 20 LTS |
| Linguagem | TypeScript 5 (ESM, strict) |
| HTTP | Fastify 5 + zod (schema validation) |
| DB | Postgres + pg (queries cruas, tipadas) |
| Filas/Cron | croner + (futuro) BullMQ + Redis |
| AI | OpenAI SDK (tool-calling nativo) |
| Logs | pino (JSON estruturado) |
| Linter/Format | biome |
| Testes | vitest |

---

## Estrutura de pastas

```
startap-platform/
├── apps/
│   ├── api/              ← Fastify, recebe webhooks WAHA
│   │   └── src/
│   │       ├── server.ts        (entry)
│   │       ├── config.ts        (validação zod)
│   │       ├── router.ts        ← substitui ROUTER_WAHA do automação visual antiga
│   │       ├── routes/
│   │       │   ├── webhook-waha.ts
│   │       │   └── health.ts
│   │       └── bots/
│   │           ├── base.ts      (classe abstrata)
│   │           └── echo.ts      (template/teste)
│   └── worker/           ← cron jobs (antibot, cleanup, relatórios)
│       └── src/
│           ├── worker.ts
│           └── jobs/*.ts
├── packages/
│   ├── core/             ← tipos + utils compartilhados
│   │   └── src/
│   │       ├── types.ts   (WahaWebhookBody, IncomingMessage, Bot)
│   │       ├── phone.ts   (parser LID/PN com testes)
│   │       └── logger.ts  (pino)
│   ├── db/               ← acesso a Postgres
│   │   └── src/
│   │       ├── client.ts  (Pool)
│   │       └── queries/   (routing, pausa, chat-memory, antibot, leads, agendamento)
│   └── integrations/     ← clientes externos
│       └── src/
│           ├── waha/      (envio mensagens WhatsApp)
│           ├── openai/    (agent com tool-calling)
│           ├── whisper/   (transcrição)
│           └── google-calendar/ (eventos)
├── docker-compose.yml
├── Dockerfile
├── biome.json
├── tsconfig.base.json
└── package.json
```

---

## Mapeamento automação visual antiga → código

| Workflow automação visual antiga | Onde foi parar |
|--------------|----------------|
| `ROUTER_WAHA` (recebe webhook, roteia) | `apps/api/src/router.ts` + `routes/webhook-waha.ts` |
| `TESTE_BARBEARIAS_AGENDAMENTOS` | `apps/api/src/bots/barbearia.ts` (a fazer) |
| `elenildo.ricardo` → `TESTE_VENDAS_CURSO` | `apps/api/src/bots/ricardo.ts` (a fazer) |
| `STARTTAP_AI` (Lola sales) | `apps/api/src/bots/startap-main.ts` (a fazer) |
| `STARTTAP_AI` (admin Samuel) | `apps/api/src/bots/startap-admin.ts` (a fazer) |
| `Cirilo_Consultar_Agendamento` | `packages/integrations/google-calendar/listEvents()` ✅ |
| `Cirilo_Inserir_Agendamento` | `packages/integrations/google-calendar/createEvent()` ✅ |
| `ALERTAS_PARA_CLIENTES` | `packages/integrations/waha/sendText()` (chamada direta) ✅ |
| `Alerta_time_interno` | Error handler global em `apps/api/server.ts` + alertas no worker |
| `Monitor_AntiBot` | `apps/worker/src/jobs/antibot.ts` ✅ |
| `Limpar_Historico_Chat` | `apps/worker/src/jobs/cleanup-chat.ts` ✅ |
| `RELATORIO_BARBEARIA_SAMUEL` | `apps/worker/src/jobs/relatorio.ts` (a fazer) |

---

## Desenvolvimento

```bash
# Instala dependências
npm install

# Roda API em watch mode
npm run dev:api

# Roda worker
npm run dev:worker

# Lint
npm run lint

# Testes
npm test
```

---

## Variáveis de ambiente

Copia `.env.example` para `.env` e preenche. Principais:

| Var | Descrição |
|-----|-----------|
| `WAHA_URL`, `WAHA_API_KEY` | Acesso à API WAHA |
| `PG_*` | Conexão Postgres (mesma do automação visual antiga) |
| `OPENAI_API_KEY` | Chave OpenAI para os bots |
| `WHISPER_URL` | Endpoint do Whisper ASR |
| `GOOGLE_OAUTH_*` | Credenciais Google Calendar |
| `ALERT_DEV_PHONE`, `ALERT_OWNER_PHONE` | Quem recebe alertas do antibot |

---

## Roadmap de migração

- [x] Esqueleto monorepo
- [x] `packages/core` (tipos, phone parser, logger)
- [x] `packages/db` (queries: routing, pausa, chat-memory, antibot, leads, agendamento)
- [x] `packages/integrations` (WAHA, OpenAI agent, Whisper, Google Calendar)
- [x] `apps/api` skeleton + Router universal
- [x] `apps/worker` skeleton + antibot + cleanup
- [x] Docker setup
- [ ] Migrar `TESTE_BARBEARIAS_AGENDAMENTOS` → `BarbeariaBot`
- [ ] Migrar `elenildo.ricardo` → `RicardoBot`
- [ ] Split + migrar `STARTTAP_AI` → `StartapMainBot` + `StartapAdminBot`
- [ ] Migrar painel-admin para o monorepo
- [ ] Job de relatório (RELATORIO_BARBEARIA_SAMUEL)
- [ ] Big bang cutover: WAHA aponta para `apps/api`, automação visual antiga parado
- [ ] Remover container automação visual antiga após 1 semana de estabilidade

---

## Decisões arquiteturais

- **Sem LangChain**: orquestração própria em `packages/integrations/openai/agent.ts`. Loop tool-calling explícito. Mais previsível, sem dependências instáveis.
- **Postgres direto, sem ORM**: queries cruas com `pg`. Wrapper fino para type safety. Migrate-style evolutivo (mesmas tabelas do automação visual antiga).
- **Bots como classes**: `BotBase` centraliza pausa, memória, envio. Cada bot só implementa `process()`.
- **Router universal**: 1 endpoint `/webhooks/waha` para todas as sessões. Roteamento por `body.session` + `telefone` na tabela `routing_clientes`.
- **Antibot no router**: bloqueio global aplicado antes de qualquer bot. Coerente.
- **Migração paralela**: automação visual antiga continua rodando até cutover. WAHA aponta para o novo `/webhooks/waha`. Rollback = re-apontar pra automação visual antiga (1 minuto).

---

## Licença

Privado, todos os direitos reservados.
