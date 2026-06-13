# Spec — Sistema de Alertas Interno (monitoramento → WhatsApp via Lola)

**DRI:** PM despacha (backend-senior, frontend-engineer, waha-specialist, devops)
**Status:** DESIGN — aguarda OK do Bruno antes do build
**Autor:** 01-arquiteto · 2026-06-12
**Apetite:** ~1 semana de build (1 migration + 1 job worker + API config no painel + 1 sub-aba)

## 0. Problema

Hoje, se a sessão WAHA do Cirilo ou do Samuel cai (FAILED/SCAN_QR_CODE/STOPPED), ninguém sabe até o cliente reclamar. Zero observabilidade. 2 pagantes 24/7. Precisamos de um detector interno simples que avise o time no WhatsApp, **sem** instalar Prometheus/Grafana agora (boring/incremental).

## 1. O que é monitorado + limiares + intervalo

Cron novo no worker (croner), **a cada 2 min** (`*/2 * * * *`), atrás de flag. Um único `runMonitor()` que avalia N checks e emite eventos de mudança de estado:

| Check | id (chave de estado) | DOWN quando | Limiar |
|---|---|---|---|
| Sessão WAHA por cliente | `waha:<sessao>` | status ∉ {WORKING} (ou 404/erro) | imediato |
| /health do startap-api | `api:health` | HTTP ≠ 200 **ou** `checks.db != ok` **ou** `checks.redis != ok` | 2 ciclos seguidos (debounce) |
| Postgres | `pg:main` | `SELECT 1` falha/timeout (já coberto via /health.checks.db; manter check direto como redundância barata do worker) | imediato |
| Disco (`/`) | `host:disk` | uso ≥ 85% (WARN log já; alerta em 90%) | 90% |
| RAM | `host:ram` | uso ≥ 90% (sem swap — margem fina) | 90% |

Notas de limiar:
- Sessões a monitorar = **somente clientes reais com sessão dedicada** + a própria Lola. Fonte: `flow_clones.waha_sessao IS NOT NULL` (clones com sessão) **+** `bot_config.waha_sessao` para `slot='startap'` (Lola/STARTAP_AI_PROD). NÃO alertar sobre sessões de teste (`WHATSAPP_ROUTER_TESTE`) nem clones `trial_status='awaiting'`/pré-setup (estado FAILED esperado, ver memória `project_fluxos_pre_setup`). Excluir por allowlist de status do clone (ex.: só `status` ativo) + flag `monitor_enabled` por linha (ver §5, opcional fase 2).
- `/health` já existe e expõe `checks.db` e `checks.redis` (apps/api/src/routes/health.ts) — reusar, não reinventar.
- Disco/RAM: ler no worker via `node:fs`/`os` do **container**? Não — o worker é containerizado e enxerga o cgroup, não o host real. **Decisão:** disco/RAM ficam como check **fase 2** e exigem um coletor no host (devops decide: um endpoint simples no host ou `df`/`free` via um pequeno script). **Fase 1 entrega só WAHA + /health + PG** (cobre o risco P0 real: sessão de cliente caída). Registrar disco/RAM como fast-follow.

## 2. Detecção de estado de cada sessão WAHA

Já existe o caminho no código real:
- `packages/integrations/src/waha/sessions.ts` → `getSessionStatus(name)` retorna `{ name, status, me }`, com timeout embutido (`DEFAULT_WAHA_TIMEOUT_MS = 8s`). Ou `GET /api/sessions` (lista todas de uma vez — é o que o painel já faz em server.js:903).
- **Recomendado:** uma chamada `GET /api/sessions` por ciclo (1 request, lista todas), montar `Map<name, status>`, e cruzar com a lista de sessões a monitorar. Evita N requests e protege o WAHA.
- WORKING = UP. Qualquer outro (`FAILED`, `SCAN_QR_CODE`, `STOPPED`, `STARTING`) ou ausência na lista (404) = DOWN.
- WAHA sem porta publicada: o worker fala via rede Docker interna (`WAHA_URL=http://waha:3000`, já no config). OK.

## 3. Módulo de entrega (texto via Lola)

Reusar `sendText` de `packages/integrations/src/waha/client.ts`:

```
sendText({ sessao: 'STARTAP_AI_PROD', chatId: '<numero>@c.us', texto, typing: false, delayMs: 0 })
```

- `sessao` = **resolver do banco**, não hardcode: `bot_config.waha_sessao WHERE slot='startap'` (hoje = `STARTAP_AI_PROD`). Default Lola.
- `typing: false` — é alerta de sistema, não conversa humana; não precisa humanizar e reduz chamadas ao WAHA.
- `chatId` = número destinatário normalizado para `<digits>@c.us` (E.164 só dígitos + `@c.us`).
- Se `sendText` lançar (Lola caída): logar erro alto, NÃO derrubar o job, NÃO re-tentar em loop (anti-flood). Próximo ciclo re-tenta naturalmente.
- **Atenção (waha-specialist):** se a própria sessão da Lola estiver DOWN, o alerta não sai. É aceitável (degradação graciosa) — registrar como limitação conhecida. Não tentar enviar pela sessão de um cliente (isolamento).

## 4. Máquina de estado anti-spam (UP/DOWN/cooldown/recovered)

Estado por check em **tabela Postgres** (não Redis — o worker do projeto usa Postgres + advisory lock, não há client Redis em apps/worker; manter o padrão). Tabela `alert_states`.

Lógica por ciclo, por check:
1. Observa estado atual `obs ∈ {up, down}`.
2. Lê linha persistida `prev` (default `up` se inexistente).
3. Transições:
   - `up → down`: **dispara alerta DOWN** ("🔴 <check> caiu …"). Grava `state=down`, `down_since=now`, `last_alert_at=now`, `alert_count=1`.
   - `down → down`: se `now - last_alert_at ≥ COOLDOWN` (default **30 min**) → **re-alerta** ("🔴 ainda caído há Xmin"), `last_alert_at=now`, `alert_count++`. Senão, silêncio.
   - `down → up`: **dispara RECUPERADO** ("🟢 <check> voltou após Xmin"). Grava `state=up`, limpa `down_since`/`last_alert_at`.
   - `up → up`: silêncio.
4. Debounce (só para `api:health`): exigir 2 observações `down` seguidas antes de transicionar para `down` (campo `pending_down_count`), evita alerta por blip de 1 ciclo.

**Proteção de flood adicional (hard cap global):** máximo de **N mensagens por janela** somando todos os checks (ex.: 10 msgs / 30 min). Se exceder, suprime e loga. Protege o número da Lola mesmo num cenário de "tudo caiu de uma vez". Contador em `alert_states` agregado ou linha sintética `__global__`.

Mensagem agregada na 1ª queda em cascata (opcional fase 2): se 2+ checks caem no mesmo ciclo, mandar 1 mensagem consolidada em vez de N.

## 5. Schema (SQL raw — migration nova, padrão do projeto)

Config é **global** (alerta do time, não por-tenant). Migration nova `035_alertas_internos.sql` (próximo número livre — confirmar no servidor antes de criar). Idempotente (IF NOT EXISTS), reversível (DROP COLUMN/TABLE), dentro de `BEGIN/COMMIT`.

```sql
BEGIN;

-- Destinatários (até 5; enforce no app + índice único por número).
CREATE TABLE IF NOT EXISTS alert_recipients (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20) NOT NULL UNIQUE,   -- E.164 só dígitos
  label       VARCHAR(60),                   -- "Bruno", "Plantão"
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Config global (1 linha) — flags e remetente.
CREATE TABLE IF NOT EXISTS alert_config (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,         -- kill-switch via UI
  sender_slot     VARCHAR(40) NOT NULL DEFAULT 'startap', -- resolve waha_sessao p/ remetente (Lola)
  cooldown_min    INT NOT NULL DEFAULT 30,
  check_waha      BOOLEAN NOT NULL DEFAULT TRUE,
  check_health    BOOLEAN NOT NULL DEFAULT TRUE,
  check_host      BOOLEAN NOT NULL DEFAULT FALSE,         -- disco/RAM fase 2
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Estado da máquina anti-spam, 1 linha por check.
CREATE TABLE IF NOT EXISTS alert_states (
  check_key          VARCHAR(80) PRIMARY KEY,   -- 'waha:STARTAP_AI_PROD', 'api:health', ...
  state              VARCHAR(10) NOT NULL DEFAULT 'up',   -- up|down
  down_since         TIMESTAMPTZ,
  last_alert_at      TIMESTAMPTZ,
  alert_count        INT NOT NULL DEFAULT 0,
  pending_down_count INT NOT NULL DEFAULT 0,     -- debounce
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
```

Enforce "até 5" no app (contar antes de inserir; rejeitar o 6º). Não usar trigger pra isso (mantém SQL boring). Validação de telefone no backend (regex E.164 dígitos) + no front.

Padrão de query: `packages/db/src/queries/alerts.ts` (novo módulo, exportado no `index.ts` como `export * as alerts`). Job lê/escreve via esse módulo. **Concorrência:** o monitor roda só no worker (instância única) → não precisa advisory lock por enquanto; se um dia escalar worker, envolver o ciclo em `pg_advisory_xact_lock`.

## 6. UI no painel de gestão

- **Onde:** aba **Configurações** (`sec-configuracoes`), nova sub-aba em `cfg-tabs` (hoje: "Fluxos", "Limpeza de logs") → adicionar **"Alertas"**. É config de sistema, encaixa aqui. NÃO criar aba nova no nav principal.
- **Campos:**
  - Toggle mestre **"Alertas ativos"** (`alert_config.enabled`).
  - Lista de até **5 destinatários**: input telefone (máscara/validação E.164) + label opcional + toggle enabled + botão remover. Botão "Adicionar" desabilita ao chegar em 5.
  - Remetente: select com default **Lola (STARTAP_AI_PROD)**; por ora só 1 opção (Lola) — deixar o campo pronto pra um futuro número dedicado.
  - Toggles por tipo de check (WAHA / Health / Host) — espelham `check_*` do config.
  - Cooldown (min) — input numérico, default 30, mín 5.
  - Botão **"Enviar teste"** → POST que dispara 1 mensagem de teste pela Lola pro primeiro número enabled (valida ponta-a-ponta sem esperar incidente).
- **Padrão de implementação:** vanilla JS como o resto do painel; rotas mutativas com CSRF (cookie `csrf_token`, já existe helper em index.html:2782) e `requireAuth` global. Backend: `GET/PUT /api/alerts/config`, `GET/POST/DELETE /api/alerts/recipients`, `POST /api/alerts/test`. Seguir o estilo das rotas existentes em server.js.

## 7. Feature flag / env (rollout sem deploy)

Duas camadas, ambas OFF por default (boring/safe):
1. **`ALERTS_ENABLED`** (env do worker, Zod opcional → default `false`, padrão lição #247: nunca crasha boot). Liga/desliga o registro do cron no `worker.ts`. Mudança exige restart do worker (não deploy de código).
2. **`alert_config.enabled`** (DB, toggle na UI) — kill-switch quente, sem restart. O job lê a cada ciclo; se `false` → no-op barato (não chama WAHA, não toca destinatários).

Com ambos OFF, o job pode até rodar e não faz nada. Ordem de ligar: deploy código (cron dormente) → provisionar `ALERTS_ENABLED=true` → cadastrar números na UI → ligar toggle → "Enviar teste".

Cron pattern via env opcional (`ALERTS_CRON`, default `*/2 * * * *`) usando o helper `scheduleCronSafe` já existente (worker.ts:24) — pattern inválido cai no fallback, não derruba boot.

## 8. Mitigação de ban da Lola (anti-abuse Meta)

- **Volume mínimo por design:** só mensagens de TRANSIÇÃO (caiu/voltou) + re-alerta a cada 30 min enquanto caído. Em operação normal (tudo UP) = **zero mensagens**.
- **Hard cap global** (§4): teto de N msgs/janela mesmo em cascata.
- **Destinatários são números conhecidos do time** (Bruno + plantão), não desconhecidos → padrão de tráfego não parece spam.
- **`typing:false`, sem mídia, texto curto** — comportamento de notificação, baixo risco.
- **RECOMENDAÇÃO REGISTRADA (hardening futuro, Bruno ciente):** usar um **número dedicado de alertas** (sessão WAHA própria, ex. `STARTAP_ALERTS`) em vez da Lola. A Lola é nosso ativo de prospecção — se for banida por volume de alertas, perdemos prospecção *e* alertas juntos. Separar isola o risco. Não é bloqueante pra fase 1; o campo `sender_slot` já deixa a porta aberta pra trocar sem refactor. Decisão fica com o Bruno.

## 9. Rollout

1. Migration `035` aplicada (deploy aplica migrations sozinho — ver memória `reference_deploy_aplica_migrations`).
2. Código mergeado com cron **dormente** (`ALERTS_ENABLED` ausente = OFF).
3. devops provisiona `ALERTS_ENABLED=true` no worker → restart worker.
4. Cadastrar número do Bruno na UI; toggle mestre ON.
5. "Enviar teste" → confirmar recebimento.
6. Validação real: waha-specialist para uma sessão de teste (NÃO de cliente) → confirmar alerta DOWN → religar → confirmar RECUPERADO.

## 10. Rollback

- **Quente:** toggle `alert_config.enabled=false` na UI (para de enviar imediatamente, sem deploy).
- **Worker:** `ALERTS_ENABLED=false` + restart (cron some).
- **Código:** reverter PR. Tabelas ficam (inertes, sem custo). Se quiser limpar: `DROP TABLE alert_*` (reversível, dados são só config/estado — sem PII de cliente além de números do time).
- Nenhuma dessas ações toca bots, sessões de cliente ou billing. Isolamento total.

## 11. Critérios de aceitação (verificáveis)

- Com tudo UP, **zero** mensagens enviadas num período de 1h.
- Parar uma sessão de teste → 1 (e só 1) mensagem DOWN em ≤ 2 min.
- Manter caído 35 min → exatamente 1 re-alerta (cooldown 30 min respeitado).
- Religar → 1 mensagem RECUPERADO.
- Lola DOWN não derruba o job (log de erro, próximo ciclo segue).
- 6º destinatário é rejeitado pela API.
- `ALERTS_ENABLED` ausente → worker sobe normal, cron não registra (ou registra e é no-op).

## 12. Quem faz o quê (build)

| Agente | Entrega |
|---|---|
| **02-backend-senior** | migration `035`; módulo `packages/db/src/queries/alerts.ts`; job `apps/worker/src/jobs/monitor.ts` + registro em `worker.ts` (com flag/scheduleCronSafe + flowExecutionLog como os outros jobs); rotas `/api/alerts/*` no painel-admin/server.js; config Zod no worker (`ALERTS_ENABLED`, `ALERTS_CRON`). |
| **04-frontend-engineer** | sub-aba "Alertas" em `sec-configuracoes`/`cfg-tabs` (public/index.html): lista de 5 números, toggles, cooldown, "Enviar teste", CSRF. |
| **03-waha-specialist** | validar `sendText` pela Lola sem quebrar a sessão; confirmar que `GET /api/sessions` é seguro a cada 2 min; revisar risco de ban e o teste de queda/recuperação numa sessão NÃO-cliente. |
| **06-devops-sre** | provisionar `ALERTS_ENABLED`/`ALERTS_CRON` no worker; (fase 2) coletor de disco/RAM do host; restart controlado. |

> Notas de escopo: PM não codifica. ADR não é exigido (mudança < 300 linhas, sem mudança de stack — é um job a mais no padrão croner já existente). Se o Bruno quiser número dedicado de alertas já na fase 1, vira decisão dele (campo `sender_slot` acomoda).
