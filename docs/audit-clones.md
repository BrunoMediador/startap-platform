# Auditoria: aba "Clones" e migrações ausentes em prod

**Data:** 2026-05-16
**Origem:** PR-V4 da MISSAO_VIAGEM (FASE 2)
**Status:** auditoria concluída — bloqueio crítico identificado

## TL;DR

A feature de clones está **100% implementada no código** (UI + API + lógica de roteamento), mas **morta em produção** porque a tabela `flow_clones` nunca foi criada. Migration 013 não rodou. Investigando os logs do deploy descobri uma causa maior: **o runner de migrações em prod só enxerga 1 dos 13 arquivos** (apenas `002`), então **as 12 migrações 003–014 nunca foram aplicadas pela pipeline automatizada**.

Boa parte do schema atual em prod (`bot_config` consolidado, `flow_execution_logs`, `flow_pauses`, etc.) foi aplicada **manualmente** em algum momento e nunca registrada em `schema_migrations`. Clones (013) e leads-por-slot (014) ficaram para trás porque foram adicionadas depois desse trabalho manual.

## O que existe no código (clones)

- **UI**: `painel-admin/public/index.html`
  - `renderBotClones` e `renderClonesList` (linhas ~2422–2500) — cards de clones na seção Bots (PR #33 integrou no grupo de Bots)
  - `openCloneWizard()` — wizard de criação a partir de matriz
  - `openCloneConfigModal()` — modal de configuração por aba (Identidade, Sessão, Personalização)
  - `openCloneQRModal()` + `pollQR()` — QR code WAHA com polling
- **API**: `painel-admin/server.js` rotas:
  - `GET /api/clones` (1449)
  - `POST /api/clones` (1467)
  - `GET /api/clones/:id` (1554)
  - `PATCH /api/clones/:id` (1573)
  - `DELETE /api/clones/:id` (1621)
  - `POST /api/clones/:id/bind-session` (1657)
  - `POST /api/sessions/create` (1691) + `/start`/`/stop`/`/status`/`/qr`
- **DB**: `packages/db/src/queries/flow-clones.ts` — 12.9KB de queries tipadas
- **Roteamento**: `apps/api/src/router.ts` resolve clone via `waha_sessao` (PR #31)
- **Migration**: `packages/db/migrations/013_flow_clones.sql` — `CREATE TABLE flow_clones`

## O que está quebrado em prod

### 1. Tabela `flow_clones` não existe
```
$ curl -u admin:startap2026 https://gestao.startap.tech/api/clones
{"error":"relation \"flow_clones\" does not exist"}
```
Consequência: o painel mostra clones se já houvesse algum, mas a lista sempre retorna 500. O botão "Clonar este" falha ao gravar. Wizard quebra.

### 2. Migration runner em prod só vê 1 arquivo
Logs do último deploy bem-sucedido (workflow_run 25974376832, 2026-05-16 22:16:55):
```
==> apply migrations
NOTICE:  relation "schema_migrations" already exists, skipping
==> apply migrations
  SKIP    002_bot_config_and_usage.sql
Migrations: 0 aplicadas, 1 puladas.
```

A pasta `packages/db/migrations/` no repo tem **13 arquivos** (`002`…`014`), mas o `find ... -name '*.sql'` no servidor só retornou `002_bot_config_and_usage.sql`. Possíveis causas:

- **Hipótese A (mais provável):** o diretório `/opt/automacoes/code/packages/db/migrations/` em prod não tem as migrations 003–014 porque o repo no servidor está em um estado anômalo (checkout antigo, rebase incompleto, branch local divergente). `git pull --rebase origin main` pode ter falhado silenciosamente.
- **Hipótese B:** algum script ou hook removeu as migrations posteriores. Improvável sem evidência.
- **Hipótese C:** o symlink/path do `MIGRATIONS_DIR` aponta para um diretório legado. O `migrate.sh` resolve via `$(dirname "$0")/../packages/db/migrations` — checar se a estrutura está intacta.

### 3. Migration 014 (leads slot) também não rodou
`GET /api/leads` em prod retorna leads sem campo `slot`. Migration 014 adicionaria essa coluna + popularia com o slot da matriz. Sem isso, o isolamento de leads por clone (PR #32) também não funciona em prod, mesmo com o código pronto.

## Recomendações (em ordem)

### Imediato (Bruno aprova antes de seguir)

1. **SSH em prod e diagnosticar o diretório de migrações:**
   ```bash
   ssh root@187.77.242.220 -p 22 \
     -i /caminho/hostinger_codex_ed25519
   cd /opt/automacoes/code/packages/db/migrations
   ls -la *.sql
   git status
   git log --oneline -3
   ```
   Esperado: 13 arquivos. Se faltarem, `git fetch origin && git reset --hard origin/main` no `/opt/automacoes/code`.

2. **Re-rodar o runner uma vez:**
   ```bash
   cd /opt/automacoes/code
   bash scripts/migrate.sh
   ```
   Migrations 003–014 são idempotentes — vão rodar como no-op se o schema já estiver no estado esperado, e aplicar 013/014 se ainda faltarem.

3. **Validar:**
   ```bash
   curl -u admin:startap2026 https://gestao.startap.tech/api/clones
   # Esperado: [] (lista vazia, sem erro)

   curl -u admin:startap2026 https://gestao.startap.tech/api/leads | jq '.[0].slot'
   # Esperado: nome do slot (não null)
   ```

### Estrutural (PR depois)

4. **Health check do migration runner no deploy:**
   No `scripts/deploy.sh`, depois do `migrate.sh`, fazer:
   ```bash
   expected=$(find packages/db/migrations -name '*.sql' | wc -l)
   applied=$(docker exec automacoes-postgres-1 psql -U "$PG_USER" -d "$PG_DB" -tAc \
     "SELECT COUNT(*) FROM schema_migrations;")
   if [ "$applied" -lt "$expected" ]; then
     echo "❌ schema_migrations tem $applied entradas, esperado $expected — abortando" >&2
     exit 1
   fi
   ```
   Se prod ficar dessincronizada de novo, o deploy falha em vez de seguir silencioso.

5. **Adicionar endpoint `GET /api/admin/migrations` no painel** que retorne lista de migrations registradas vs arquivos no repo. Facilita auditoria sem precisar SSH.

## Por que esta PR é só docs

Per MISSAO_VIAGEM: "Time PARA se: precisa mudar schema (migration)". O passo 1 da recomendação (re-rodar migrate.sh) é leitura/execução em prod, que cai no mesmo limite. Documenta a investigação e aguarda sinal verde do Bruno.

## Estado da FASE 2 da viagem

Bruno planejou: `PR-V4: Auditar aba "Clones" atual. Se estiver pronto, sem código. Se estiver incompleto, planeja PRs seguintes.`

Resposta: **a UI e o backend estão completos** (PRs #30, #31, #32, #33 já mergeados). O bloqueio é exclusivamente de **schema em prod**. Não há `PR-V5..VN` de implementação a planejar — o fix é operacional (rodar a migration). Após o sinal verde, FASE 2 está concluída.
