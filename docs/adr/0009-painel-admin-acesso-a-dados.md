# ADR 0009: Acesso a Dados do painel-admin

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0009-painel-admin-acesso-a-dados.md`
> **Relacionada à Missão:** 014 — Onda 3a ADR Painel via API

---

**Status:** proposta — aguardando aprovação de Bruno
**Data:** 2026-05-19
**Autor:** arquiteto
**Aprovado por:** pendente

---

## Contexto

`painel-admin/server.js` (3161 linhas) mantém seu próprio `pg.Pool` (linha 253) com apenas
`connectionTimeoutMillis` configurado — sem `statement_timeout`. Esse pool compete diretamente
com o pool de `packages/db` usado pela API TypeScript, que define `statement_timeout: 10000 ms`
(packages/db/src/client.ts:18).

O arquivo executa 138 chamadas `pool.query` / `pool.connect` / `client.query` em 71 rotas HTTP,
todas acessando o banco diretamente. Zero chamadas chegam a `apps/api` — a variável `TS_API_URL`
(linha 35) existe mas é usada apenas para compor a URL de webhook, nunca para trafegar dados.

Rotas de mutação identificadas (POST/PUT/PATCH/DELETE): 32 rotas que escrevem em tabelas como
`routing_clientes`, `bot_config`, `bot_prompt`, `bot_media`, `bot_courses`, `flow_clones`,
`flow_pause_keywords` e `gcal_tokens`. Rotas de leitura: 39.

Dependências hardcoded adicionais:
- `TS_BOTS` (linhas 39-85): lista estática de 4 bots com IDs. Novo bot exige edição manual.
- `BOT_MODEL_CONTEXT` (linhas 87-129): contexto de modelo para 5 slots, mantido manualmente.
- `FLOW_LEADS_TABLE` (linhas 131-136): mapeamento flow_id → tabela de leads.
- `DEFAULT_PROJECT_DATABASES` (linhas 138+): lista de projetos com metadados de tabelas.

Consequências do estado atual:
- Uma query analítica travada no painel (ex: `/api/metrics/timeseries`) pode esgotar o pool
  e bloquear requisições de usuário finais que chegam pelo mesmo Postgres.
- Mutações do painel não aparecem em `flow_execution_logs` — auditoria fica cega para operações
  administrativas.
- Payload de entrada não passa por validação Zod — erros de tipo chegam diretamente ao SQL.
- Listas de bots e tabelas devem ser atualizadas em dois lugares: `server.js` e o código TypeScript.

---

## Decisao

Adotar a **Opcao C — Hardening do pool + guards no painel** como passo imediato, com caminho
deliberado para a Opcao B (migração gradual de mutações para a API) ao longo das missões filhas.

O painel-admin continuará acessando o banco diretamente, mas com:
1. `statement_timeout` configurado no pool do painel (igual ao da API).
2. Listas hardcoded (`TS_BOTS`, `BOT_MODEL_CONTEXT`, `DEFAULT_PROJECT_DATABASES`) removidas e
   substituídas por queries em `bot_config` — tabela que já existe e é a fonte de verdade.
3. Mutações críticas (clones, gcal, routing) migradas para endpoints `/admin/*` na API Fastify
   em fases priorizadas — sem big bang, sem prazo único.

---

## Alternativas consideradas

### Opcao A — Status quo (sem mudanca)

- **Como funcionaria:** manter pool sem timeout, listas hardcoded, zero auditoria de mutações.
- **Pros:** zero esforço imediato; painel funciona hoje.
- **Contras:** risco de saturação de pool persiste; listas de bots divergem a cada novo clone;
  auditoria é impossível; dívida cresce a cada feature nova adicionada direto no `server.js`.
- **Descartada porque:** o custo de manutenção aumenta linearmente com o número de clones, e o
  risco de pool starvation é real em queries longas de métricas.

### Opcao B — Migração total para apps/api

- **Como funcionaria:** cada uma das 71 rotas do painel seria reescrita como chamada HTTP à API
  Fastify. O `server.js` vira apenas proxy HTML + autenticação básica.
- **Pros:** fonte única de verdade; Zod em todas as mutações; auditoria completa; pool unificado.
- **Contras:** esforço estimado de 3-5 semanas (71 rotas, 138 queries, contratos de payload a
  definir); o painel e a API são containers separados — mudança de URL base afeta o frontend;
  risco de regressão alto em operações complexas como criação de clone (transação de 5 tabelas,
  linhas 2335-2502).
- **Descartada como passo único:** válida como destino, mas o big bang é arriscado. Vira plano
  de fases dentro da Opcao C+.

### Opcao C — Hardening do pool + guards no painel (ESCOLHIDA)

- **Como funcionaria:** (1) adicionar `statement_timeout` e `max` ao pool do painel; (2) eliminar
  listas hardcoded substituindo por query em `bot_config`; (3) migrar mutações críticas para a
  API em fases, priorizando por risco — sem reescrever rotas de leitura a menos que haja motivo.
- **Pros:** resolve os riscos imediatos (pool starvation, listas divergentes) com mudanças
  pontuais; permite entregas incrementais sem parar o painel; preserva a velocidade que o painel
  atual oferece para consultas complexas.
- **Contras:** a dívida de auditoria e validação Zod não desaparece de vez — diminui a cada fase.
- **Escolhida porque:** atende `feedback_team_velocity` (entrega rápido primeiro) sem sacrificar
  segurança. O risco imediato (pool sem timeout) é corrigido na Fase 0, de baixo custo.

### Opcao D — Endpoints do painel como rotas /admin/* na API

- **Como funcionaria:** mover as rotas de `server.js` para dentro de `apps/api` como grupo
  `/admin/*` com autenticação separada. O `server.js` serviria apenas os arquivos estáticos.
- **Pros:** unificação completa; pool único; Zod nativo.
- **Contras:** requer mover ~3000 linhas de Express para Fastify com contrato diferente;
  autenticação Basic Auth precisaria ser reimplementada; painel e API passam a ter o mesmo
  ponto de falha; esforço similar à Opcao B.
- **Descartada:** custo equivalente ao B sem ganho adicional. Pode ser destino de longo prazo,
  mas não resolve o problema imediato.

---

## Consequências

### Positivas
- Pool do painel para de competir sem limites com a API — Fase 0 resolve sozinha.
- Listas de bots passam a vir do banco: novo clone aparece no painel sem deploy.
- Mutações críticas ganham validação Zod e log de auditoria conforme migradas.
- Cada fase é entregável independente — sem dependência de fase completa para ir a prod.

### Negativas / trade-offs
- Dois pools continuam existindo enquanto a migração não for concluída — operacional necessário.
- Mutações que ainda ficam no painel seguem sem Zod até serem migradas.
- Rotas de leitura analíticas (métricas, timeseries) provavelmente nunca migrarão — custo vs
  ganho não justifica para leitura simples.

### Neutras
- O painel permanece em Express — não há plano de reescrever o frontend desta missão.
- Containers continuam separados; URLs do frontend não mudam nas fases iniciais.

---

## Plano de migração

**Fase 0 — Hardening do pool (baixo risco, ~1 dia de dev-back)**
- Adicionar `statement_timeout`, `max` e `idleTimeoutMillis` ao `pool` em `server.js:253`.
- Remover `TS_BOTS`, `BOT_MODEL_CONTEXT` e `DEFAULT_PROJECT_DATABASES` — substituir por
  query em `bot_config` no handler de `/api/bots` e `/api/database/projects`.
- Sem mudança de contrato de API — painel continua funcionando igual para o frontend.

**Fase 1 — Migrar mutações de clone para apps/api (médio risco, ~3-4 dias)**
- Endpoints candidatos: `POST /api/clones`, `PATCH /api/clones/:id`, `DELETE /api/clones/:id`,
  `PUT /api/clones/:id/gcal`, `POST /api/clones/with-waha`.
- Esses endpoints contêm as transações mais complexas e são os de maior risco de regressão.
  Migrar primeiro garante auditoria onde importa.
- Painel passa a chamar `fetch(TS_API_URL + '/admin/clones', ...)`.

**Fase 2 — Migrar mutações de routing e bot-config (baixo risco, ~2 dias)**
- `POST /api/routing`, `PUT /api/routing/:id`, `DELETE /api/routing/:id`.
- `PUT /api/bots/:slot`, `PUT /api/bots/:slot/prompt`, `PUT /api/bots/:slot/pause-keywords`.

**Fase 3 — Avaliar rotas restantes (decisão futura)**
- Rotas de leitura analítica (métricas, logs, timeseries) ficam no painel por padrão.
- Revisão após Fases 0-2: decidir se vale migrar ou se pool com timeout é suficiente.

---

## Validação

- **Fase 0:** query de metrics com `pg_sleep(15)` simulada não derruba requests simultâneas
  da API. `SHOW statement_timeout` no pool do painel retorna `10s`.
- **Fase 0:** `/api/bots` retorna bots dinâmicos do banco — adicionar novo `bot_config` aparece
  sem deploy de `server.js`.
- **Fase 1:** criação de clone via painel aparece em `flow_execution_logs`.
- **Fases 1-2:** tester valida smoke test completo do painel após cada fase antes de mergear.

---

## Rollback

- **Fase 0:** reverter os dois commits é seguro — sem mudança de schema, sem contrato alterado.
- **Fases 1-2:** cada rota migrada mantém o endpoint antigo no painel comentado por 1 sprint.
  Se regressão detectada, reativar endpoint local e abrir issue.

---

## Riscos abertos

1. **Sobreposição de contratos:** alguns endpoints do painel retornam campos extras que o
   frontend usa mas que a API Fastify não expõe hoje. Mapeamento exato só possível durante
   implementação de cada fase.
2. **Autenticação nas rotas /admin/\*:** a API Fastify não tem Basic Auth hoje — precisará de
   decisão sobre mecanismo (Bearer token, mTLS, rede interna). Isso é pré-requisito da Fase 1.
3. **Transação de 5 tabelas na criação de clone** (linhas 2335-2502): é a query mais complexa
   do painel. Migrar para a API requer cuidado especial com rollback parcial — dev-back deve
   revisar antes de começar Fase 1.

---

## Referencias

- Missao 014: `docs/missoes/014-onda-3a-adr-painel-via-api.md`
- ADR 0006: `docs/adr/0006-google-calendar-por-clone.md` (referência de padrão de autenticação por slot)
- Auditoria 2026-05-19: `docs/auditorias/2026-05-19-painel-prod.md`
- `packages/db/src/client.ts:18` — statement_timeout de referência (10 s)
- `painel-admin/server.js:253` — pool atual sem timeout
- `painel-admin/server.js:39-129` — listas hardcoded a remover na Fase 0
