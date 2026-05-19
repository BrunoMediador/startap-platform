# Auditoria 2026-05-19 — Fase 0: VPS Disco e Estratégia de Backup

**DRI:** infra  
**Data:** 2026-05-19  
**Status:** CONCLUIDA  
**Missão:** 011  

---

## 1. Sumário executivo

O VPS `187.77.242.220` está com 72/100 GB ocupados e não existe backup do Postgres. A análise
estática do código revela que `flow_execution_logs` (sem limite de retenção até o worker v2),
`model_usage` (sem cleanup algum) e os logs de container Docker (sem rotation configurada no
compose) são os principais candidatos a crescimento irrestrito. A stack tem 30 worktrees de
agentes Claude em `.claude/worktrees` — cada um com `node_modules` completo — que no ambiente
local somam 341 MB e no VPS podem somar vários GB se copiados via deploy. O diagnóstico exato
de cada consumidor depende de autorização SSH (Passo 3 abaixo).

---

## 2. Análise estática local (sem SSH)

### 2.1 Logs Docker — rotation

**Achado:** nenhum dos três arquivos (`docker-compose.yml`, `Dockerfile`, `painel-admin/Dockerfile`)
declara `logging:` com `driver: json-file` + `max-size`/`max-file`. O Docker usa o driver
`json-file` por padrão, sem rotation, o que significa que os logs de containers com alto
throughput (WAHA, worker antibot a cada 1 min, API) crescem indefinidamente em
`/var/lib/docker/containers/<id>/<id>-json.log`.

O worker executa o job `antibot` **a cada 1 minuto** e registra ao menos 2 eventos em
`flow_execution_logs` por ciclo (started + finished). São 2.880 INSERT por dia apenas do
antibot, sem contar o fluxo principal de mensagens.

**Risco alto** para logs de container e para `flow_execution_logs`.

### 2.2 Política de cleanup

| Componente | Mecanismo | Retenção atual |
|---|---|---|
| `chat_histories*` (7 tabelas estáticas + clones) | `pruneAllHistories` — mantém últimas N msgs por session_id | `CHAT_MEMORY_RETENTION=30` (msgs por sessão, NÃO dias) |
| `flow_execution_logs` | `pruneOldFlowEvents(14)` — DELETE WHERE created_at < NOW() - 14 days | 14 dias — OK se worker roda |
| `model_usage` | **Nenhum cleanup** | Cresce indefinidamente |
| `flow_pauses` | Sem cleanup | Provavelmente pequena (só flags de pausa) |
| `leads` | Sem cleanup | Depende de volume de prospecção |

**Achado crítico:** `model_usage` não tem TTL/cleanup. Cada chamada ao LLM gera 1 INSERT. Se
o bot processa centenas de mensagens por dia, essa tabela pode ter centenas de milhares de
linhas. Sem `pg_vacuum`, bloat TOAST.

**Achado crítico:** O cleanup de `flow_execution_logs` (`pruneOldFlowEvents(14)`) só roda se
o worker (`startap-worker`) estiver saudável. Se o container reiniciou e ficou parado por
algum período, logs acumulam sem cleanup.

### 2.3 Tabelas que tendem a crescer — ranking de risco

1. **`flow_execution_logs`** — antibot (2/min) + fluxo principal. Tem TTL 14d mas só se
   worker rodar. Metadata JSONB pode ser volumosa.
2. **`model_usage`** — sem TTL. Cresce a cada chamada ao LLM.
3. **`chat_histories*`** — 7 tabelas + clones. Controlado por quantidade, não tempo. Pode
   acumular sessions abandonadas de clientes de teste.
4. **`n8n_chat_histories*`** — 3 tabelas legacy com typo (`controle_de_pausee`, `controle_de_pauseee`)
   que provavelmente não são mais limpas pelo cleanup TS (o cleanup usa prefixo `chat_histories`,
   não `n8n_chat_histories`). Ver migration 006 — tabelas com nome `n8n_*` podem estar sem
   cleanup ativo.
5. **Logs Docker de container** — sem rotation declarada. Whisper (9000) e WAHA (3000) são
   especialmente verbosos.

### 2.4 Volumes declarados no compose

```
redis_data   — persistência Redis (AOF/RDB)
pg_data      — volume implícito do Postgres legacy (automacoes-postgres-1 não está no compose TS)
```

O `docker-compose.yml` do repo TS não declara `pg_data` — o Postgres (`automacoes-postgres-1`)
provavelmente é gerenciado por uma stack separada (`/opt/automacoes/docker-compose.yml` ou
similar) com volume próprio.

### 2.5 Estimativa de código + node_modules

| Item | Tamanho local |
|---|---|
| `node_modules` raiz monorepo | 137 MB |
| `.claude/worktrees` (30 worktrees, cada um com node_modules) | 341 MB |
| VPS: node_modules em build intermediário Docker | incluído na image layer |

No VPS os worktrees não devem existir (`.gitignore`), mas as **Docker image layers** de builds
anteriores podem somar GBs. `docker system df` vai revelar.

---

## 3. Comandos SSH necessários (Passo 2 — lista exata)

Agrupados por objetivo. Nenhum comando é destrutivo (somente leitura).

### Grupo A — Disco geral

```bash
df -h
du -sh /var/lib/docker/containers /var/lib/docker/overlay2 /var/lib/docker/volumes /var/lib/docker/image 2>/dev/null | sort -h
du -sh /opt/automacoes/* 2>/dev/null | sort -h
du -sh /opt/automacoes/code/ 2>/dev/null
```

### Grupo B — Docker

```bash
docker system df
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | sort -k2 -h
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

### Grupo C — Logs de container (volume, não conteúdo)

```bash
ls -lh /var/lib/docker/containers/ | head -5
find /var/lib/docker/containers -name '*-json.log' -exec du -sh {} \; 2>/dev/null | sort -h | tail -20
```

### Grupo D — Postgres (tamanho total e por tabela)

```bash
docker exec automacoes-postgres-1 psql -U startap_user -d startap_database -c "SELECT pg_size_pretty(pg_database_size('startap_database'));"
docker exec automacoes-postgres-1 psql -U startap_user -d startap_database -c "SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE relkind='r' AND n.nspname='public' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 30;"
docker exec automacoes-postgres-1 psql -U startap_user -d startap_database -c "SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 20;"
docker exec automacoes-postgres-1 psql -U startap_user -d startap_database -c "SELECT COUNT(*) AS total_model_usage FROM model_usage;"
docker exec automacoes-postgres-1 psql -U startap_user -d startap_database -c "SELECT COUNT(*) AS total_flow_logs, MIN(created_at) AS mais_antigo FROM flow_execution_logs;"
docker exec automacoes-postgres-1 psql -U startap_user -d startap_database -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'n8n_%' OR table_name LIKE 'chat_%' ORDER BY 1;"
```

### Grupo E — Volume de logs recentes

```bash
docker logs --since 1h startap-api 2>&1 | wc -l
docker logs --since 1h startap-worker 2>&1 | wc -l
docker logs --since 1h automacoes-waha-1 2>&1 | wc -l
docker logs --tail 5 startap-worker 2>&1
```

### Grupo F — Redis

```bash
docker exec startap-redis redis-cli info memory | grep -E 'used_memory_human|maxmemory'
docker exec startap-redis redis-cli dbsize
```

---

## 4. Resultado do diagnóstico SSH (2026-05-19)

Autorização concedida pelo Bruno em 2026-05-19. Comandos executados: grupos A–F conforme §3.

### 4.1 Disco geral (Grupo A)

| Filesystem | Tamanho | Usado | Livre | % |
|---|---|---|---|---|
| `/dev/sda1` (root) | 96 GB | **72 GB** | 25 GB | **75%** |
| `/boot` | 881 MB | 64 MB | 756 MB | 8% |

Subdivisão de `/opt/automacoes/`:

| Caminho | Tamanho |
|---|---|
| `/opt/automacoes/videos/` | **67 MB** |
| `/opt/automacoes/code/` | **148 MB** |
| `/opt/automacoes/backups/` | 436 KB |
| `/opt/automacoes/painel-admin/` | 76 KB |
| `/opt/automacoes/logs/` | 56 KB |
| backups `.tgz` avulsos | ~40 KB total |

Subdivisão de `/var/lib/docker/`:

| Caminho | Tamanho |
|---|---|
| `/var/lib/docker/containers/` | 4.9 MB |
| `/var/lib/docker/volumes/` | 125 MB |
| `/var/lib/docker/image/` | 152 KB |
| `/var/lib/docker/overlay2/` | **N/A — `du` retornou vazio** (dados reais via `docker system df`) |

### 4.2 Docker (Grupo B)

| Tipo | Total | Ativo | Tamanho | Recuperavel |
|---|---|---|---|---|
| Images | 10 | 10 | 67.26 GB | 67.26 GB (100% ativo) |
| Containers | 10 | 10 | 1.087 GB | 0 B |
| Volumes | 5 | 5 | 129.8 MB | 0 B |
| **Build Cache** | 2704 entradas | 0 | **58.04 GB** | **26.08 GB reclaimable** |

Imagens por tamanho:

| Imagem | Tamanho |
|---|---|
| `openai-whisper-asr-webservice` | **7.56 GB** |
| `devlikeapro/waha-plus` | **3.19 GB** |
| `jc21/nginx-proxy-manager` | 1.66 GB |
| `postgres:16` | 641 MB |
| `code-api` / `code-worker` | 414 MB cada |
| `automacoes-painel-admin` | 226 MB |
| `node:20-alpine` | 194 MB |
| `nginx:alpine` | 93.5 MB |
| `redis:7-alpine` | 57.8 MB |

Containers rodando: **todos os 10 containers UP** (API/worker reiniciados 2h atrás via deploy, WAHA há 3 dias, Whisper há 2 meses).

### 4.3 Logs de container (Grupo C)

| Container (hash parcial) | Log size |
|---|---|
| Maior log (b3d82d — Whisper ou NPM) | 3.0 MB |
| Segundo maior (d18738 — NPM) | 752 KB |
| Terceiro (74b849 — Postgres) | 512 KB |
| Demais | < 200 KB |
| Total todos os json.log | < 5 MB |

**Conclusao:** logs de container estao controlados. O problema nao e log rotation hoje — e o build cache.

### 4.4 Postgres (Grupo D)

**Tamanho total do banco:** `18 MB`

Top tabelas por tamanho:

| Tabela | Tamanho | Linhas vivas |
|---|---|---|
| `flow_execution_logs` | 5.984 MB | 13.269 |
| `chat_histories` | 288 KB | 91 |
| `chat_histories_controle_de_pausee` | 184 KB | — |
| `flow_clones` | 144 KB | — |
| `model_usage` | 136 KB | **152 linhas** |
| `chat_histories_vendas_barbearia` | 136 KB | 92 |
| `bot_media` + `bot_prompt` | 120 KB cada | — |

Dados relevantes:
- `model_usage`: apenas **152 linhas** — insignificante hoje, mas sem TTL (cresce para sempre)
- `flow_execution_logs`: **13.269 linhas**, mais antiga de **2026-05-15** (4 dias) — TTL 14d funcionando corretamente
- Tabelas `n8n_chat_histories*` **nao existem** no banco — nomes no banco sao `chat_histories*` (sem prefixo n8n). Achado estático da analise local era impreciso; as tabelas com typos sao `controle_de_pausee` / `controle_de_pauseee` que sao da stack TS, nao do n8n legado.
- `last_autovacuum` presente em todas as tabelas principais — autovacuum saudavel.

Tabelas `chat_*` no banco: 7 tabelas, todas com prefixo `chat_histories` (sem n8n). Sem tabelas n8n legadas.

### 4.5 Volume de logs recentes (Grupo E)

| Container | Linhas na ultima hora |
|---|---|
| `startap-api` | **0** linhas |
| `startap-worker` | **8** linhas |
| `automacoes-waha-1` | **77** linhas |

Worker esta **vivo e saudavel**: logs mostram ciclos de cleanup (`deleted:0, tables:7`) e antibot (`blocked:0, pruned:1-4`) a cada minuto. TTL do `flow_execution_logs` esta rodando.

### 4.6 Redis (Grupo F)

| Metrica | Valor |
|---|---|
| `used_memory_human` | **964 KB** |
| `maxmemory` | 0 (sem limite configurado) |
| `maxmemory_policy` | `noeviction` |
| `dbsize` | **0 chaves** |

Redis praticamente vazio. `noeviction` sem limite e tecnicamente arriscado em producao mas com 0 chaves e uso de 964 KB e inofensivo agora.

---

## 5. Plano de limpeza priorizado (input Missao 012)

Com base nos dados reais, os top 5 consumidores de disco sao:

| # | Consumidor | Tamanho real | Natureza |
|---|---|---|---|
| 1 | Docker build cache | **58 GB** (26 GB reclaimable) | Cache acumulado de builds anteriores |
| 2 | Imagens Docker em uso | **67 GB** total (Whisper 7.56 GB, WAHA 3.19 GB, NPM 1.66 GB) | Imagens ativas — nao pode apagar sem plano |
| 3 | Container layer writes | 1.087 GB | Escrita em runtime (WAHA maior: 20.2 MB) |
| 4 | `/opt/automacoes/code/` | 148 MB | Repo + node_modules no VPS |
| 5 | Docker volumes (db_storage) | 126.7 MB | Postgres data volume |

Nota: logs de container (< 5 MB total) e banco Postgres (18 MB) estao muito menores do
que a analise estatica temia. O problema e quase totalmente o build cache de 58 GB.

### 5.1 Acoes de limpeza priorizadas

| Prioridade | Acao | Comando exato | Ganho estimado | Risco |
|---|---|---|---|---|
| **P1** | Limpar build cache completo | `docker builder prune -a -f` | **~58 GB** | **low** — cache e sempre regeneravel; proximo build demora mais mas funciona |
| **P2** | Configurar BuildKit keep-storage no daemon | Adicionar `"builder": {"gc": {"enabled": true, "defaultKeepStorage": "10GB"}}` em `/etc/docker/daemon.json` + `systemctl reload docker` | Previne recrescimento | low — sem downtime de containers |
| **P3** | Log rotation em todos containers | Adicionar `logging: {driver: json-file, options: {max-size: 50m, max-file: "3"}}` no compose de ambas as stacks | < 1 GB hoje, previne crescimento | low — via PR, aplica no proximo `up -d` |
| **P4** | TTL 30d em `model_usage` | Migration + job no worker (padrao ja existe em `pruneOldFlowEvents`) | Insignificante hoje, previne crescimento | low — migration versionada |
| **P5** | Verificar e limpar tabelas `chat_histories_controle_de_pause{e,ee}` | `SELECT COUNT(*), MAX(created_at) FROM chat_histories_controle_de_pausee;` — se orfas, DROP via migration | < 200 KB hoje | medium — confirmar que nenhum bot ativo usa antes de DROP |

Nota: nao ha acao para `n8n_chat_histories*` — essas tabelas nao existem no banco.
Achado da analise estatica era um falso positivo. As tabelas com typos sao `controle_de_pausee`
e `controle_de_pauseee`, que sao da stack TS (nao legado n8n).

---

## 6. Estrategia de backup definitiva (input Missao 012)

### 6.1 Decisao por tamanho — banco real 18 MB

O `pg_dump` comprimido de um banco de 18 MB ficara em torno de 3-8 MB (estimativa: 20-40%
do raw em `.sql.gz`). Estrategia: **Git puro** — commit por dump no repo privado.
Nao ha necessidade de Git LFS ou GitHub Releases.

### 6.2 Onde rodar o backup: recomendacao

**Recomendacao: GitHub Actions com SSH no VPS.**

Razoes:
1. **Visibilidade:** cada run fica como execucao do Actions — falha aparece no painel GitHub
   com log completo. Cronjob no VPS falha silenciosamente.
2. **Sem dependencia de estado do VPS:** se o VPS tiver problema de disco ou cron corrompido,
   o backup no Actions ainda tenta conectar e alerta via falha de workflow.
3. **Token/segredo no GitHub Secrets:** SSH private key fica em `GH_SECRET` junto com os
   demais segredos CI — sem secret novo no VPS.
4. **Retencao automatica:** workflow de cleanup de dumps antigos tambem roda no Actions,
   sem depender de cron do VPS.

### 6.3 Especificacao do backup

- **Repo:** `BrunoMediador/startap-backups` (privado) — Bruno deve criar antes da Missao 012
- **Schedule:** `cron: '0 6 * * *'` (06:00 UTC = 03:00 BRT, fora do pico)
- **Formato:** `dumps/daily/YYYY-MM-DD-HHMMSS.sql.gz` (plain SQL comprimido)
- **Retencao:** 30 daily + 1 semanal por 6 meses (26 weeklies via `dumps/weekly/`)
- **Tamanho estimado por dump:** 3-8 MB comprimido. 30 diarios = 90-240 MB total no repo.
  Bem abaixo do limite de 1 GB de repo GitHub.

### 6.4 Dependencia critica: criptografia de gcal_credentials_json

O dump contera `gcal_credentials_json` em plaintext na tabela `bot_config`. Esse campo
guarda o JSON do Service Account OAuth do cliente. O primeiro dump so pode ser comitado
apos a Missao 012 criptografar esse campo (tarefa A6 da Missao 012).

Sequencia correta:
1. Missao 012 implementa criptografia de `gcal_credentials_json`
2. Migration roda em producao, campo fica criptografado no banco
3. Repo `startap-backups` criado pelo Bruno
4. Primeiro dump disparado manualmente pra validar

---

## 7. Riscos abertos e perguntas para o Bruno

| # | Risco / Pergunta | Impacto | Acao necessaria |
|---|---|---|---|
| R1 | `docker builder prune -a -f` apaga todo o cache — proximo deploy demora mais | Baixo: build de 2-4 min passa para 8-15 min na primeira vez | Autorizar P1 da Missao 012 explicitamente |
| R2 | Redis sem `maxmemory` configurado (`noeviction`) — pode crescer sem limite | Baixo hoje (0 chaves, 964 KB) | Adicionar `maxmemory 256mb` e `maxmemory-policy allkeys-lru` no compose |
| R3 | `gcal_credentials_json` em plaintext no banco — qualquer backup expoe credenciais OAuth | Alto: se repo de backup for comprometido | Missao 012-A6 DEVE criptografar antes do primeiro dump |
| R4 | Container `automacoes-api` (node:20-alpine, porta 3001, ha 4 dias) nao documentado no compose TS | Desconhecido: pode ser stack legada | Bruno confirmar o que e esse container |
| R5 | Build cache pode recrescer se `--keep-storage` nao for configurado no daemon | Alto: em 2-3 semanas de CI, 58 GB voltam | P2 deve ser aplicado junto com P1 |

Perguntas diretas:
1. Bruno, o `automacoes-api` (porta 3001) e da stack legada `/opt/automacoes/`? Pode ser
   parado ou e parte do produto ativo?
2. Bruno, pode criar o repo `BrunoMediador/startap-backups` (privado) antes da Missao 012?
3. Bruno, autoriza `docker builder prune -a -f` no VPS como parte da Missao 012-P1?
   Isso recupera imediatamente 26-58 GB de disco.

---

## 8. Conclusao e proximos passos

### Estado atual do VPS

- **Disco:** 72/96 GB usados (75%) — confortavel por ora, mas build cache deve ser limpo
- **Principal problema:** Docker build cache **58 GB** (26 GB reclaimable imediatamente)
- **DB saudavel:** 18 MB, worker rodando, TTL de logs funcionando, autovacuum ativo
- **Logs OK:** < 5 MB total em containers — rotation e preventivo, nao urgente
- **Redis OK:** 0 chaves, 964 KB — inofensivo

### Proximos passos imediatos

| Passo | Responsavel | Pode comecar quando |
|---|---|---|
| gerente-pr abre PR desta auditoria | `gerente-pr` | Agora — nenhuma dependencia |
| dev-back implementa PR-A1 (fix mock flowClones da Missao 012) | `dev-back` | Agora — nao depende desta auditoria |
| Bruno cria repo `startap-backups` (privado) | Bruno | Quando tiver 5 min |
| Missao 012: P1 — `docker builder prune -a -f` + configurar `daemon.json` | `infra` | Apos autorizacao do Bruno |
| Missao 012: A6 — criptografia `gcal_credentials_json` | `dev-back` + `arquiteto` | Apos arquiteto definir estrategia |
| Missao 012: primeiro backup | `infra` | Apos P1 + A6 completados |

Status desta auditoria: **CONCLUIDA**. Passos 1-8 executados. Dados reais coletados.
Plano de limpeza e estrategia de backup definitivos documentados.
