# API Reference — Startap Platform

Referência rápida dos endpoints HTTP de cada componente.

- **apps/api** — porta 3040 — webhooks WAHA + health
- **painel-admin** — porta 3030 — admin UI, exige Basic Auth (`ADMIN_USER` / `ADMIN_PASS`)

Convenção: paths começam com `/api/*` no painel; webhook em `/webhooks/*` no api.

---

## apps/api · webhooks e health

### `GET /health`
Liveness probe. Retorna `{ ok: true }` se o processo está vivo.

### `GET /health/db`
Verifica conexão Postgres. `{ ok: true }` ou 500 com `error`.

### `POST /webhooks/waha`
Recebe webhook WAHA (mensagens, eventos de sessão, etc). Roteamento:
1. Extrai `body.session` + `body.payload.from`.
2. Resolve bot via `registry`:
   - `flow_clones.waha_sessao === body.session` → roteia pro bot clone (instância parametrizada pela matriz).
   - Senão, mapeia sessão direto pra bot (`registerBot('startap', botStartap)` etc).
3. Antibot + pausa global aplicados antes de delegar.
4. Bot executa `process(ctx)` e responde via `waha.sendText`.

Body de exemplo (mensagem texto):
```json
{
  "event": "message",
  "session": "WHATSAPP_ROUTER_TESTE",
  "payload": {
    "id": "false_5535...@c.us_3A...",
    "timestamp": 1700000000,
    "from": "5535...@c.us",
    "fromMe": false,
    "body": "olá",
    "hasMedia": false
  }
}
```

Resposta: sempre `200` (WAHA não re-tenta em 4xx/5xx, então erros são logados e respondem 200).

---

## painel-admin

Todos os endpoints exigem `Authorization: Basic <base64(user:pass)>`. Em prod: `admin:startap2026` (basic auth header).

### Mídia

| Método | Path | Função |
|---|---|---|
| `GET` | `/media-proxy?u=<url>` | Proxy HTTPS para mídia HTTP interna (evita mixed-content). Host whitelisted. Suporta `Range`. |
| `POST` | `/api/uploads/media` | Upload de mídia via multipart (`file`). Salva em `MEDIA_STORAGE_DIR`. Tamanho máximo `MEDIA_UPLOAD_MAX_MB`. |
| `DELETE` | `/api/media/:id` | Apaga registro de `bot_media`. |

### Roteamento de telefones (legado)

| Método | Path | Body / Query | Função |
|---|---|---|---|
| `GET` | `/api/routing` | — | Lista entradas em `routing_clientes`. |
| `POST` | `/api/routing` | `{ telefone, workflow_id, ... }` | Cria roteamento. |
| `PUT` | `/api/routing/:id` | `{ ... }` | Atualiza. |
| `DELETE` | `/api/routing/:id` | — | Remove. |

> Em uso decrescente — roteamento moderno é por **sessão WAHA** via `flow_clones`, não por telefone.

### Bots (configuração de modelo)

| Método | Path | Função |
|---|---|---|
| `GET` | `/api/bots` | Lista bot_config + metadata (flow_id, models_in_flow). |
| `PUT` | `/api/bots/:slot` | Atualiza provider/model/temperature. |
| `GET` | `/api/bots/:slot/prompt` | Lê prompt customizado de `bot_prompt`. |
| `PUT` | `/api/bots/:slot/prompt` | Salva prompt. |
| `GET` | `/api/bots/:slot/media` | Lista mídias de `bot_media`. |
| `POST` | `/api/bots/:slot/media` | Adiciona mídia (após `/api/uploads/media`). |

### Uso de IA / custos

| Método | Path | Query | Função |
|---|---|---|---|
| `GET` | `/api/usage/summary` | `?days=N` (1-90, default 7) | Soma `model_usage` por slot/provider/model. |
| `GET` | `/api/usage/daily` | — | Histórico diário agregado. |
| `GET` | `/api/usage/recent` | — | Últimas N chamadas. |

### Workflows / fluxos

| Método | Path | Função |
|---|---|---|
| `GET` | `/api/workflows` | Lista de fluxos cadastrados em `project_databases` (matrizes + clones). |
| `PATCH` | `/api/workflows/:id/active` | Ativa/desativa um fluxo. |
| `GET` | `/api/workflows/:workflowId/pause-keywords` | Lista keywords de pausa configuradas (`flow_pause_keywords`). |
| `PUT` | `/api/workflows/:workflowId/pause-keywords` | Atualiza keywords. |

### Status / logs

| Método | Path | Função |
|---|---|---|
| `GET` | `/api/status` | `{ flows, waha, execucoes }`. Sessões WAHA, contagem de fluxos ativos, últimas execuções. |
| `GET` | `/api/flow-logs` | Lista `flow_execution_logs` paginada com filtros (`?slot`, `?status`, `?event_type`, `?q`, `?execution_id`). |
| `GET` | `/api/flow-logs/summary` | Resumo agregado de execuções. |
| `GET` | `/api/flow-logs/stream` | SSE com novos logs em tempo real. |
| `POST` | `/api/flow-logs/prune` | Body `{ days }` — apaga logs com mais de N dias. |

### Database explorer (read-only)

| Método | Path | Função |
|---|---|---|
| `GET` | `/api/database/projects` | Lista projetos em `project_databases` + tabelas por projeto. |
| `GET` | `/api/database/projects/:projectId/tables/:tableKey` | Lê uma tabela do projeto (paginada). |

### Leads & relatórios

| Método | Path | Query | Função |
|---|---|---|---|
| `GET` | `/api/leads` | `?slot=<slot>` | Lista leads de `leads_ricardo` + `leads_vendas_barbearia`. Filtra por slot do clone. |
| `GET` | `/api/agendamentos-pendentes` | — | Lista `agendamento_pendente`. |
| `GET` | `/api/message-stats` | — | `[{dia, total}]` dos últimos 14 dias (de `flow_execution_logs WHERE event_type='webhook.received'`). |

### Cleanup / manutenção

| Método | Path | Função |
|---|---|---|
| `GET` | `/api/cleanup/status` | Última execução do cron de limpeza + próxima + cron string. |

### Clones (matrizes → clientes)

> Requer migração 013 aplicada. Em prod (2026-05-16) ainda **não aplicada** — veja [audit-clones.md](./audit-clones.md).

| Método | Path | Body | Função |
|---|---|---|---|
| `GET` | `/api/clones` | — | Lista todos os clones. |
| `POST` | `/api/clones` | `{ matriz_slot, slot, display_name, cliente_*, personalizacao? }` | Cria clone a partir de matriz. |
| `GET` | `/api/clones/:id` | — | Detalhe + status WAHA. |
| `PATCH` | `/api/clones/:id` | `{ display_name?, personalizacao?, cliente_*?, status? }` | Atualiza campos editáveis. |
| `DELETE` | `/api/clones/:id` | — | Remove clone. |
| `POST` | `/api/clones/:id/bind-session` | `{ session_name }` | Liga uma sessão WAHA existente ao clone. |

### Sessões WAHA

| Método | Path | Função |
|---|---|---|
| `POST` | `/api/sessions/create` | Body `{ name }`. Cria sessão na WAHA via REST. |
| `POST` | `/api/sessions/:name/start` | Inicia sessão. |
| `POST` | `/api/sessions/:name/stop` | Para sessão. |
| `GET` | `/api/sessions/:name/status` | Status da sessão (`WORKING`, `STARTING`, etc). |
| `GET` | `/api/sessions/:name/qr` | QR code base64 para parear o WhatsApp. |

---

## Códigos de status

| HTTP | Quando |
|---|---|
| `200` | Sucesso. |
| `204` | Sucesso sem body (raro). |
| `400` | Body inválido (zod ou validação manual). |
| `401` | Falta `Authorization` no painel. |
| `403` | Host bloqueado em `/media-proxy`. |
| `404` | Slot/clone/sessão não encontrado. |
| `500` | Erro interno (banco fora, WAHA timeout). Resposta `{ error: <mensagem> }`. |
| `502` | Falha em proxy (WAHA upstream timeout em `/media-proxy`). |

## Convenções

- **Datas**: ISO-8601 UTC (`2026-05-16T22:00:00.000Z`).
- **Slot**: `string` PascalCase ou snake_case (e.g. `teste_barbearia`, `barbearia-cirilo-bruno`).
- **Telefone**: `\d{12,13}@c.us` (chatId WhatsApp).
- **Custo**: `cost_usd` em `NUMERIC(12,6)` — sempre USD.
- **Tokens**: integers.

## Como descobrir o shape exato de um endpoint

```bash
curl -s -u admin:startap2026 https://gestao.startap.tech/<path> | jq
```

Em dev local:
```bash
curl -s -u admin:startap2026 http://localhost:3030/<path> | jq
```
