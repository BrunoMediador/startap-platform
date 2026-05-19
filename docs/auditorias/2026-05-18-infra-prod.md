# Auditoria Infra Produção — 2026-05-18

**Executor:** infra  
**Data:** 2026-05-18  
**Servidor:** 187.77.242.220 (Hostinger VPS, Docker stack)  
**Acesso SSH:** bloqueado pelo auto-mode do Claude Code — logs de container obtidos indiretamente via `/api/flow-logs`, `/api/cleanup/status` e análise de código-fonte.

---

## Resumo Executivo

| Área | Status | Severidade |
|------|--------|------------|
| Containers em execução | NAO_VALIDADO | — |
| cleanup_log legado | CORRIGIDO (task-18) | ALTO |
| Pausa cross-bot (3 números) | PENDENTE_DECISAO_BRUNO | ALTO |
| Logs de erro (painel-admin) | NAO_VALIDADO (SSH bloqueado) | — |
| Logs de erro (api/worker/waha) | NAO_VALIDADO (SSH bloqueado) | — |
| Worker cleanup-chat | OK (evidência indireta) | BAIXO |

---

## Seção 1 — Containers (requer SSH)

**Comando pendente (executar manualmente):**
```bash
ssh -i ~/.ssh/hostinger_codex_ed25519 root@187.77.242.220 -p 22 \
  "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'"
```

**Status conhecido via /api/flow-logs (evidência indireta):**

| Container | Evidência | Status Inferido |
|-----------|-----------|-----------------|
| startap-api | flow-logs recentes, último evento 2026-05-18T23:46 | UP |
| startap-worker | worker.job-started/finished regulares às 22:00 e 23:00 | UP |
| startap-redis | sem erros de conexão Redis nos logs | UP |
| automacoes-waha-1 | WAHA sessions WORKING, mensagens chegando | UP |
| automacoes-postgres-1 | queries respondendo, pool conectado | UP |
| automacoes-painel-admin-1 | HTTP 200 no health check via /api/usage/summary | UP |
| automacoes-npm-1 (NPM) | gestao.startap.tech acessível | UP |
| automacoes-whisper-1 | sem transcrições com erro nos logs (áudios processados) | UP |

---

## Seção 2 — Logs de Container (requer SSH)

**SSH foi bloqueado pelo auto-mode.** Os comandos abaixo devem ser executados manualmente para validação completa:

```bash
# Logs de erro dos containers principais (últimas 500 linhas, filtrado)
docker logs startap-api --tail 500 2>&1 | grep -iE "error|exception|fatal|uncaught" | tail -50
docker logs startap-worker --tail 500 2>&1 | grep -iE "error|exception|fatal|crash" | tail -50
docker logs automacoes-painel-admin-1 --tail 500 2>&1 | grep -iE "error|exception|fatal" | tail -50
docker logs automacoes-waha-1 --tail 500 2>&1 | grep -iE "error|exception|fatal" | tail -50
```

**Achados indiretos via /api/flow-logs (últimos 500 eventos):**

- `error_events = 0` — nenhum evento com status='error' nos últimos 500
- `error_summary` nunca preenchido nos últimos 500 eventos
- Sem `webhook.crash` nos logs
- Worker: padrão job-started → job-finished sem falhas registradas

**Conclusão:** sem evidência de erros críticos via API, mas validação direta de stderr via SSH é obrigatória antes de fechar esta auditoria.

---

## Seção 3 — Task 18: cleanup_log parou em 2026-05-15

### Diagnóstico

A tabela `cleanup_log` era alimentada pelo n8n (automação visual legada), que foi aposentado em 2026-05-15 quando o `startap-worker` (TypeScript) entrou em produção.

O endpoint `/api/cleanup/status` continuava lendo `cleanup_log`, retornando `last_run=2026-05-15T23:00` — parecendo que o cleanup havia parado, quando na verdade o worker TS está ativo e escrevendo em `flow_execution_logs`.

**Evidência do worker ativo:**
- `/api/flow-logs` confirma `worker.job-started` + `worker.job-finished` para `cleanup-chat` às 22:00 e 23:00 de 2026-05-18
- Cron no `apps/worker/src/worker.ts`: `'0 * * * *'` — todo hora, timezone America/Sao_Paulo

**Decisão técnica:** substituir a query do endpoint para ler de `flow_execution_logs` com `flow_id='worker:cleanup-chat'` e `event_type='worker.job-finished'`. Código legado de n8n (`cleanup_log`, `cleanup_historicos`) mantido no banco — DROP fica pendente com arquiteto após validação em prod.

**Correção:** `painel-admin/server.js` atualizado no commit `task-18`. PR em `fix/auditoria-painel-infra`.

---

## Seção 4 — Task 19: 3 números em pausa no startap também roteiam para teste_barbearia

### Diagnóstico

Números envolvidos:
- `5511979630828` (Cirilo) — em `pause_startap` E em `routing_clientes → teste_barbearia`
- `554999976116` (Adilson) — em `pause_startap` E em `routing_clientes → teste_barbearia`
- `559691564310` (chermont) — em `pause_startap` (sem routing confirmado)

**Fluxo do problema:**

1. Cirilo/Adilson mandam mensagem para o número da Startap (sessão `STARTAP_AI_PROD`)
2. Router detecta `sessionEntry = startapBotEntry` → verifica `pause_startap` → bloqueia. **Correto.**
3. Mas se mandam mensagem para o número do ROUTER_TESTE (sessão `WHATSAPP_ROUTER_TESTE`):
   - Router detecta `sessionEntry = null` (nenhum bot tem essa sessão como `ownedSessions`)
   - Router não verifica `pause_startap`
   - `findRoute(telefone)` acha o registro em `routing_clientes → teste_barbearia`
   - Mensagem é processada pelo `teste_barbearia` **mesmo com o atendente humano ativo no startap**

**Raiz técnica em `router.ts`:**
```
// Linha 270-291: verificação de pausa de sessão própria só ocorre quando sessionEntry existe
if (sessionEntry?.legacyPauseTable) { ... verificar pause_startap ... }
// Se sessionEntry é null (ROUTER_TESTE), este bloco não executa.
// Segue direto para findRoute → routing_clientes.
```

### Decisão pendente de Bruno

Há duas abordagens, com trade-offs distintos:

**Opção A — Pausa por bot (comportamento atual):**
- Pausa em `startap` só bloqueia mensagens recebidas na sessão startap.
- Mesma pessoa pode receber resposta do `teste_barbearia` enquanto humano está atendendo no startap.
- Sem mudança de código necessária.
- Risco: loop silencioso — cliente em atendimento humano no startap recebe mensagem automática do teste_barbearia.

**Opção B — Pausa cross-bot (pausa global por telefone):**
- Qualquer pausa ativa em qualquer bot bloqueia o telefone em TODOS os bots.
- Implementação: antes de `findRoute` no router, verificar `pause_startap` (e futuramente outras tabelas de pausa) para bloquear globalmente.
- Elimina o loop silencioso.
- Risco: pode bloquear acidentalmente clientes que são tanto lead do startap quanto testadores do barbearia (cenário incomum mas possível).

**Recomendação infra:** Opção B, limitada ao conjunto de números explicitamente em pausa (`flow_pauses` com `active=TRUE`), que é a tabela canônica do worker TS. A tabela `pause_startap` é legado; `flow_pauses` já existe e é usada pelo router para startap.

---

## Achados Novos (não cobertos pela auditoria anterior)

| ID | Achado | Severidade | Ação |
|----|--------|------------|------|
| NEW-01 | `cleanup_log` e `cleanup_historicos` são tabelas órfãs (n8n legado). Ocupam espaço e podem confundir futuras auditorias. | BAIXO | DROP após validação — tarefa para arquiteto criar migration |
| NEW-02 | `STARTAP_WORKFLOW_NAME = 'STARTTAP_AI'` (duplo T) em `bots/startap.ts` — typo persistente que aparece em flow_name nos logs. | BAIXO | Renomear constante e garantir migração de registros antigos |
| NEW-03 | `STARTAP_SESSION_NAMES` inclui `'startap,STARTAP_AI,STARTAP_AI_PROD'` — 3 aliases. Se algum desses for usado como sessão real no WAHA, mensagens de reply do próprio bot chegam com `fromMe=true` e disparam `session-paused` check. Confirmar via SSH quais sessões estão realmente ativas. | MEDIO | Validar sessões WAHA ativas via SSH ou WAHA API |

---

## Próximos Passos

1. **SSH manual obrigatório** — executar os comandos da Seção 2 para fechar o item NAO_VALIDADO.
2. **Bruno decide** — Opção A vs Opção B para pausa cross-bot (task-19).
3. **Após decisão Bruno** — infra implementa task-19 no mesmo PR ou em PR separado.
4. **Arquiteto** — criar migration para DROP de `cleanup_log` e `cleanup_historicos`.
5. **dev-back** — corrigir typo `STARTTAP_AI` → `STARTAP_AI` (NEW-02).
