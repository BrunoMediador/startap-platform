# Startap Platform

Plataforma de bots WhatsApp da Startap. Monorepo TypeScript que substitui os workflows n8n.

**Servidor**: `187.77.242.220` em `/opt/automacoes/code/`
**Painel**: https://gestao.startap.tech

---

## Bots em producao

| Slot | Bot | Funcao | Provider/Modelo |
|------|-----|--------|-----------------|
| `teste_barbearia` | TesteBarbeariaBot | Agendamento Google Calendar | openai/gpt-4o |
| `teste_vendas` | TesteVendasBot | Funil de vendas (videos V1/V2/V3) | openai/gpt-4o |
| `teste_vendas_barbearia` | TesteVendasBarbeariaBot | Hibrido vendas + barbearia | openai/gpt-4o |
| `startap` | StartapBot | Lola - prospeccao comercial | deepseek/deepseek-chat |

---

## Arquitetura

```
WAHA (WhatsApp)
  │ webhook POST /webhooks/waha
  ▼
┌──────────────────────────────────────────────────┐
│  apps/api (Fastify)                              │
│                                                  │
│  webhook-waha.ts → router.ts → Bot.handle(ctx)   │
│    ├─ extrai telefone (LID/PN)                   │
│    ├─ antibot + pausa global                     │
│    ├─ busca routing_clientes                     │
│    ├─ flow_controls (ativar/desativar)            │
│    └─ delega para o Bot registrado               │
│                                                  │
│  BotBase (base.ts):                              │
│    ├─ pausa por projeto                          │
│    ├─ memoria de chat (project:session:flow:tel) │
│    ├─ log de execucao (flow_execution_logs)       │
│    └─ envio com typing humanizado                │
└───────┬──────────────────────────────────────────┘
        │
        ├→ packages/integrations/waha      (envio WhatsApp)
        ├→ packages/integrations/openai    (agent tool-calling)
        ├→ packages/integrations/whisper   (transcricao audio)
        └→ packages/integrations/google-calendar (agenda)

┌──────────────────────────────────────────────────┐
│  apps/worker (cron jobs)                         │
│    ├─ antibot        (1min)                      │
│    └─ cleanup-chat   (diario 03h)                │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  painel-admin (Node.js + HTML)                   │
│    ├─ Roteamento de clientes                     │
│    ├─ Modelos IA (provider/model/temperature)    │
│    ├─ Prompts editaveis (placeholders runtime)   │
│    ├─ Midias editaveis (V1/V2/V3/POS_VIDEOS)    │
│    ├─ Flow Controls (ativar/desativar fluxos)    │
│    ├─ Project Databases (bancos logicos)         │
│    └─ Logs de execucao                           │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  Postgres                                        │
│    routing_clientes, bot_config, bot_prompt,      │
│    bot_media, flow_controls, project_databases,   │
│    flow_execution_logs, model_usage,              │
│    n8n_chat_histories_*, pausa_*, leads_*         │
└──────────────────────────────────────────────────┘
```

---

## Stack

| Camada | Tecnologia |
|--------|------------|
| Runtime | Node.js 20 LTS |
| Linguagem | TypeScript 5 (ESM, strict) |
| HTTP | Fastify 5 + zod |
| DB | Postgres + pg (queries tipadas, sem ORM) |
| AI | OpenAI SDK (tool-calling) + DeepSeek |
| Cron | croner |
| Cache | Redis 7 |
| Logs | pino (JSON estruturado) |
| Linter | biome |
| Testes | vitest |
| Deploy | Docker + Docker Compose |

---

## Estrutura do monorepo

```
startap-platform/
├── apps/
│   ├── api/                  # API Fastify - webhooks WAHA
│   │   └── src/
│   │       ├── server.ts
│   │       ├── config.ts
│   │       ├── router.ts     # Router universal (substitui n8n)
│   │       ├── routes/
│   │       │   ├── webhook-waha.ts
│   │       │   └── health.ts
│   │       ├── bots/
│   │       │   ├── base.ts   # BotBase (abstrata)
│   │       │   ├── echo.ts
│   │       │   ├── startap.ts
│   │       │   ├── teste_barbearia.ts
│   │       │   ├── teste_vendas.ts
│   │       │   └── teste_vendas_barbearia.ts
│   │       └── lib/
│   │           ├── render-prompt.ts
│   │           └── run-agent.ts
│   └── worker/               # Cron jobs
│       └── src/
│           ├── worker.ts
│           └── jobs/
│               ├── antibot.ts
│               └── cleanup-chat.ts
├── packages/
│   ├── core/                 # Tipos + utils compartilhados
│   │   └── src/
│   │       ├── types.ts
│   │       ├── phone.ts
│   │       └── logger.ts
│   ├── db/                   # Acesso Postgres
│   │   ├── migrations/       # SQL idempotentes (002-007)
│   │   └── src/
│   │       ├── client.ts
│   │       └── queries/
│   │           ├── routing.ts
│   │           ├── pausa.ts
│   │           ├── chat-memory.ts
│   │           ├── bot-config.ts
│   │           ├── bot-prompt.ts
│   │           ├── bot-media.ts
│   │           ├── flow-control.ts
│   │           ├── flow-execution-log.ts
│   │           ├── model-usage.ts
│   │           ├── leads.ts
│   │           ├── antibot.ts
│   │           └── agendamento.ts
│   └── integrations/         # Clientes externos
│       └── src/
│           ├── waha/
│           ├── openai/
│           ├── whisper/
│           └── google-calendar/
├── painel-admin/             # Painel administrativo
│   ├── server.js
│   ├── public/index.html
│   └── Dockerfile
├── n8n-backup/               # JSONs dos workflows originais
├── scripts/
│   ├── deploy.sh
│   └── seed-prompts.mjs
├── docs/
│   ├── platform-architecture.md
│   ├── data-model.md
│   ├── conversation-scope.md
│   ├── operations-runbook.md
│   └── adr/                  # Architecture Decision Records
├── docker-compose.yml
├── Dockerfile
├── biome.json
├── tsconfig.base.json
└── package.json
```

---

## Configuracao editavel via painel

O painel (https://gestao.startap.tech) permite editar sem deploy:

- **Prompts**: textarea com placeholders `{nome}`, `{telefone}`, `{data_atual}`, `{ano}`, `{agenda}`
- **Modelos IA**: provider, model, temperature por bot
- **Midias**: URLs de videos por posicao (V1/V2/V3/POS_VIDEOS) com contexto
- **Flow Controls**: ativar/desativar fluxos
- **Roteamento**: vincular telefones a bots

Cache de 30s. Alteracao reflete em ate 30s sem restart.

---

## Tabelas Postgres

### Configuracao
- `bot_config` — provider/model/temperature por slot
- `bot_prompt` — system prompt editavel por slot
- `bot_media` — midias com posicao, contexto e toggle

### Controle
- `routing_clientes` — telefone → workflow_id
- `flow_controls` — ativar/desativar fluxos
- `project_databases` — bancos logicos por projeto

### Operacional
- `flow_execution_logs` — logs detalhados de cada execucao
- `model_usage` — tracking de tokens e custo por bot
- `n8n_chat_histories_*` — memoria de chat por projeto
- `pausa_*` / `bot_pausa` — controle de pausa por projeto/antibot
- `leads_*` — leads capturados
- `message_log` — log de mensagens antibot
- `agendamento_pendente` — agendamentos aguardando confirmacao

---

## Desenvolvimento local

```bash
# Instalar dependencias
npm install

# API em watch mode
npm run dev:api

# Worker
npm run dev:worker

# Lint
npm run lint

# Testes
npm test

# Build
npm run build
```

---

## Variaveis de ambiente

Copie `.env.example` para `.env` e preencha:

| Variavel | Descricao |
|----------|-----------|
| `PG_*` | Conexao Postgres |
| `REDIS_HOST/PORT` | Redis para filas |
| `WAHA_URL`, `WAHA_API_KEY` | API WhatsApp |
| `WHISPER_URL` | Whisper ASR |
| `OPENAI_API_KEY` | OpenAI para bots |
| `DEEPSEEK_API_KEY` | DeepSeek para Lola |
| `GOOGLE_OAUTH_*` | Google Calendar |
| `ADMIN_USER/PASS` | Painel admin |
| `ALERT_*_PHONE` | Telefones para alertas |

---

## Deploy

Fluxo PR-based:

```
VS Code → branch → push → PR → review → merge → deploy
```

```bash
# No servidor, apos merge:
ssh root@187.77.242.220 "cd /opt/automacoes/code && ./scripts/deploy.sh"
```

O `deploy.sh` faz: `git pull` → `docker compose build --no-cache` → `docker compose up -d` → health check.

---

## Containers Docker

| Container | Porta | Funcao |
|-----------|-------|--------|
| `startap-api` | 3040 | API principal |
| `startap-worker` | - | Jobs em background |
| `startap-redis` | 6379 | Cache/filas |
| `automacoes-painel-admin-1` | 3030 | Painel web |
| `automacoes-waha-1` | 3000 | WhatsApp engine |
| `automacoes-whisper-1` | 9000 | Transcricao audio |
| `automacoes-postgres-1` | 5432 | Banco de dados |
| `automacoes-npm-1` | 80/443 | Nginx Proxy Manager |

---

## Licenca

Privado. Todos os direitos reservados.
