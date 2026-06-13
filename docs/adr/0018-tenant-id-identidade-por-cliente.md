# ADR 0018: `tenant_id` — Identidade Única (UUID) por Cliente, Ancorada em `flow_clones`

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0018-tenant-id-identidade-por-cliente.md`
> **Quando usar:** Pilar 1 dos "3 pilares de escala" (decisão do Bruno, 2026-06-12). Pré-requisito de RLS (fase 2) e de billing/relatório confiável.

---

**Status:** aceito (Fase 1 em PR #280) — migration 045 (coluna nullable + backfill) implementada; dual-write, cutover e RLS são fases seguintes (ainda proposta)
**Data:** 2026-06-12
**Autor:** arquiteto
**Aprovado por:** Bruno (ancoragem em `flow_clones` e Fase 1) — fases 2+ pendentes
**Relacionados:** ADR 0007 (isolamento de memória por `slot`), ADR 0014/0016 (billing por `slot`), migration 044 (template de aditivo idempotente), migration 045 (`packages/db/migrations/045_tenant_id_nullable_backfill.sql`, PR #280 — execução da Fase 1). Faz par com ADR 0019 (lock idempotência) e ADR 0020 (shard WAHA).

---

## Contexto

### Estado real (confirmado no código e no banco de prod, 2026-06-12)

A **tenant key de fato** é a coluna `slot` (string) — não existe `tenant_id`, não existe RLS. `grep -rl tenant_id` em `packages` + `apps` retorna **vazio**. O `slot` aparece como discriminador em ~17 arquivos de `packages/db/src/queries/`.

A âncora canônica de tenant é a tabela **`flow_clones`**:

- `flow_clones.slot VARCHAR(80)` é a chave do clone (ex.: `clone_cirilobarbearia_c8w2f0`).
- `flow_clones.matriz_slot` (matriz de origem), `flow_clones.waha_sessao` (sessão WAHA), `flow_clones.flow_enabled`, `flow_clones.trial_status`.
- `client_billing.slot` e `billing_charges.slot` **já são** `REFERENCES flow_clones(slot) ON DELETE CASCADE` (migrations 040/041). Ou seja, `flow_clones` já é o pai referencial do tenant.

Linhas reais em prod (`flow_clones`):

| slot | matriz_slot | waha_sessao | flow_enabled |
|---|---|---|---|
| `clone_barbeariacarlosolvv_u216yd` | teste_barbearia | barbeariacarlosolvv | t (teste do Bruno) |
| `clone_barbearia_samuel_uefpqc` | teste_barbearia | barbearia_samuel | f (começa domingo) |
| `clone_cirilobarbearia_c8w2f0` | teste_barbearia | cirilobarbearia | t (PAGANTE) |
| `clone_edu_barbeiro_glh7vd` | teste_barbearia | clone_edu_barbeiro_glh7vd | t (trial) |

Além disso há slots "de plataforma" em `bot_config`/`model_usage` sem linha em `flow_clones`: `startap` (Lola), `teste_barbearia` (matriz/router de teste), `teste_vendas` e `teste_vendas_barbearia` (vestígios da vertical de vendas descontinuada).

### Set REAL de tabelas slot-anchored (corrigido contra o schema, 2026-06-12)

> **Correção sobre a 1ª versão deste ADR.** A primeira redação listou `leads`, `bot_pausa` e `flow_pause_keywords` como satélites de tenant. Ao implementar a migration 045 (PR #280), o `backend-senior` confirmou no schema real que **essas três NÃO são slot-anchored** e foram removidas do escopo. Regra de ouro: quando o ADR diverge do schema, confia-se no schema real e corrige-se o ADR.

Tabelas que **de fato** carregam dados de tenant via coluna `slot` (casável com `flow_clones.slot`):

`flow_clones` (âncora), `bot_config`, `bot_prompt`, `bot_media`, `bot_courses`, `client_billing`, `billing_charges`, `model_usage`.

Tabelas que foram **removidas** do set (não têm coluna `slot` no schema real):

- **`leads`** — não existe. A tabela real é **`leads_vendas_barbearia`** e ela **não tem `slot`** (`id`, `nome`, `telefone`, `mensagem_inicial`, `origem`, `criado_em`). Sem como resolver `slot → tenant_id`. Fora.
- **`bot_pausa`** — tabela **legada** chaveada por `numero_cliente` (telefone) + flag `pausado`; **sem coluna `slot`**. Fora.
- **`flow_pause_keywords`** (e `flow_pauses`) — chaveadas por `flow_id` (id de workflow WAHA, ex. `0ni38aSspWwhooHd`), **não por `slot`**. Fora.

Mapear essas três para `tenant_id` é um passo separado (exige primeiro resolver `flow_id`/telefone → `slot`) e fica fora do escopo da Fase 1.

O histórico de chat (`chat_histories*`) também não tem coluna `slot` — usa `slot` como **prefixo do `session_id`** (ADR 0007) e fica fora deste ADR.

### A dor concreta que isso resolve

1. **Billing/relatório frágil:** `billing-charges.ts` e `client-billing.ts` chaveiam por string `slot`. Relatórios cross-tabela (ex.: "MRR + uso de IA por cliente") hoje só se montam com `JOIN ... ON x.slot = y.slot` repetido — e o roadmap menciona "UNION manual frágil de billing/relatório". String como chave de junção é frágil a typo (já houve um typo de slot do Cirilo corrigido na migration 028), a rename e a colisão.
2. **RLS bloqueada:** uma policy de RLS sã precisa de uma chave de tenant estável e indexada por linha. `slot VARCHAR(80)` espalhado funciona, mas um `tenant_id UUID` por linha é o que a fase 2 (RLS) vai usar em `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
3. **Identidade reaproveitável:** um cliente pode (futuro) ter mais de um clone/projeto. `slot` é por-clone; `tenant_id` permite agrupar clones do mesmo cliente sem reescrever todas as queries.

### Restrições que moldam a decisão

- **Sem ORM.** Schema é responsabilidade explícita; cada mudança é migration SQL raw idempotente versionada por `schema_migrations` (`scripts/migrate.sh`). Migration aplicada nesta fase: **045**.
- **Migrations idempotentes e aditivas** (padrão da migration 044: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).
- **Deploy aplica migrations sozinho** pós-merge na main (gate PR45). Logo: uma migration aditiva nullable é segura de mergear sem janela.
- **Constraint dura do Bruno:** zero downtime, zero re-pareamento dos bots no ar. `tenant_id` é 100% camada de banco/app — **não toca WAHA**, então é o pilar mais seguro dos três sob essa ótica.

---

## Decisão

**Adicionar `tenant_id UUID` como identidade de tenant, ancorada em `flow_clones`, e propagá-la para as tabelas de dados de cliente de forma ADITIVA, NULLABLE, em fases reversíveis: coluna → backfill a partir do `slot` → dual-write → cutover de leitura → (fase 2 separada) `NOT NULL` + FK + RLS.**

**Fase 1 já executada** na migration `045_tenant_id_nullable_backfill.sql` (PR #280): coluna aditiva + backfill. Dual-write, cutover de leitura e RLS são fases seguintes, ainda em estado de proposta.

Mecânica:

1. `flow_clones` ganha `tenant_id UUID NOT NULL DEFAULT gen_random_uuid()` (a tabela é a fonte da verdade do tenant; cada clone existente nasce/recebe um UUID estável).
2. As tabelas-satélite que hoje chaveiam por `slot` ganham `tenant_id UUID NULL` (sem FK ainda, sem NOT NULL ainda — espelha exatamente a postura aditiva da migration 044). Set real: `bot_config`, `bot_prompt`, `bot_media`, `bot_courses`, `client_billing`, `billing_charges`, `model_usage`.
3. O backfill preenche `tenant_id` nas satélites resolvendo `slot → flow_clones.tenant_id`.
4. O código passa a **escrever** `tenant_id` junto do `slot` (dual-write) e depois a **ler/filtrar** por `tenant_id`, com `slot` mantido como coluna legível e como chave de transição.
5. **Fase 2 (ADR próprio, não neste release):** `tenant_id NOT NULL`, FK para `flow_clones`, e RLS. RLS é decisão à parte porque muda o contrato de conexão (cada request precisa setar `app.tenant_id`) e tem risco operacional real (request sem o set = zero linhas).

`slot` **não é removido**. Ele continua sendo a coluna legível por humanos (painel, logs, sessão WAHA) e a chave que o operador entende. `tenant_id` é a chave de máquina para junção e isolamento.

### Por que ancorar em `flow_clones` e não criar uma tabela `clients` nova

A `data-model.md` descreve uma tabela `clients` "alvo" com `id`. Mas isso é o modelo aspiracional; o modelo **real** já tem `flow_clones` como pai de `client_billing`/`billing_charges` via FK `ON DELETE CASCADE`. Introduzir `clients` agora seria uma 2ª fonte de verdade de tenant convivendo com `flow_clones` — exatamente o tipo de divergência que causa bug. Ancorar `tenant_id` em `flow_clones` reusa a topologia de FK que já existe e é a mudança mínima reversível. Se um dia precisarmos de `clients` (1 cliente → N clones), `flow_clones.tenant_id` vira FK para `clients(id)` num ADR futuro — sem reescrever as satélites. **Bruno aprovou esta ancoragem.**

---

## Alternativas consideradas

### Opção A — `tenant_id UUID` aditivo ancorado em `flow_clones`, fases nullable→backfill→dual-write→cutover ← **ESCOLHIDA**
- **Pros:** reusa FK existente; cada fase é reversível e segura com cliente online; nenhuma fase exige janela; `slot` preservado para legibilidade; abre caminho limpo pra RLS sem comprometer com ela agora.
- **Contras:** período de dual-write com duas chaves coexistindo (transitório); RLS fica pra fase 2.
- **Escolhida porque:** é a evolução incremental de menor risco que mata a fragilidade de junção e destrava RLS, sem tocar nos bots no ar.

### Opção B — Criar tabela `clients` nova (modelo aspiracional da data-model.md)
- **Pros:** modelo "limpo" 1 cliente → N projetos/clones.
- **Contras:** 2ª fonte de verdade de tenant convivendo com `flow_clones`; exige migrar as FKs de `client_billing`/`billing_charges` de `slot`→`client_id`; muito maior que 300 linhas; risco alto de divergência durante a transição.
- **Descartada porque:** escopo grande demais para o ganho imediato. Pode ser fase futura por cima de `flow_clones.tenant_id`.

### Opção C — Manter `slot` como única chave e ir direto pra RLS por `slot`
- **Pros:** zero migration de coluna nova.
- **Contras:** RLS por string de 80 chars é viável mas frágil (typo/rename quebra isolamento silenciosamente); não resolve a fragilidade de junção; não dá identidade reaproveitável.
- **Descartada porque:** o Bruno pediu explicitamente "identidade única (UUID) por cliente". UUID é a chave de isolamento correta para RLS.

### Opção D — `tenant_id` como `BIGSERIAL` em vez de UUID
- **Pros:** índice menor, menos bytes.
- **Contras:** sequencial vaza ordem/contagem de clientes; UUID é gerável client-side (provisioning) sem round-trip; o pedido do Bruno é UUID.
- **Descartada porque:** UUID é o pedido e a escolha certa para multi-tenant (não-adivinhável, gerável no onboarding).

---

## Consequências

### Positivas
- Chave de junção estável e indexável por linha → relatório/billing cross-tabela deixa de depender de string.
- `tenant_id` por linha é o pré-requisito direto de RLS (fase 2) sem reabrir o schema.
- Provisioning de clone novo passa a carimbar `tenant_id` na criação (UUID gerável no app).
- Zero impacto em WAHA/sessões: é 100% banco + app. Atende a constraint dura do Bruno.

### Negativas / trade-offs
- Período transitório com `slot` E `tenant_id` coexistindo (dual-write). Disciplina de revisão para não esquecer de carimbar `tenant_id` em INSERTs novos.
- `chat_histories*` não ganha `tenant_id` neste ADR (continua usando `slot` no prefixo do `session_id`, ADR 0007). Mapear chat para `tenant_id` é um sub-passo opcional via coluna derivável depois — não bloqueia billing/relatório.
- `leads_vendas_barbearia`, `bot_pausa` e `flow_pauses`/`flow_pause_keywords` ficam fora do `tenant_id` nesta fase (não são slot-anchored). Mapeá-las exige resolver `flow_id`/telefone → `slot` num passo separado.
- RLS real só na fase 2 — até lá o isolamento continua sendo de aplicação (mesma postura de hoje, não pior).

### Neutras
- `startap` (Lola), `teste_barbearia` (matriz/router), `teste_vendas` e `teste_vendas_barbearia` não têm linha em `flow_clones`. Após o backfill (`WHERE s.slot = fc.slot`) eles ficam com `tenant_id NULL` **de propósito** — `tenant_id` de plataforma é decisão de seed à parte (passo 0). Esperado, não é bug.

---

## Plano de migração (incremental, flag-gated, reversível)

Cada passo declara: o que faz, se é **seguro com cliente online**, gate de risco, validação e rollback.

### Passo 0 — Inventário e decisão dos slots de plataforma — **seguro online**
- Confirmar set de slots/tabelas (este ADR já o fez, e o set foi corrigido contra o schema real na migration 045). Decidir o `tenant_id` de `startap`, `teste_barbearia`, `teste_vendas` e `teste_vendas_barbearia` (seeds fixos ou excluídos do escopo de cliente). **Sem código.**
- **Validação:** lista de (tabela, coluna slot) revisada pelo PM. **Rollback:** n/a.
- **Apetite:** 0.5 dia (`arquiteto` + `backend-senior`).

### Passo 1 — Migration 045: coluna aditiva + backfill — **seguro online** — ✅ FEITO (PR #280)
- `ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT gen_random_uuid();` (gera UUID por clone existente automaticamente).
- `ADD COLUMN IF NOT EXISTS tenant_id UUID NULL` nas satélites **reais**: `bot_config`, `bot_prompt`, `bot_media`, `bot_courses`, `client_billing`, `billing_charges`, `model_usage`. (`leads`/`bot_pausa`/`flow_pause_keywords` removidas — não são slot-anchored, ver §"Set REAL".)
- Backfill no MESMO arquivo, idempotente: `UPDATE <satelite> s SET tenant_id = fc.tenant_id FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id IS NULL;`.
- Índices: `CREATE INDEX IF NOT EXISTS idx_<t>_tenant ON <t>(tenant_id);`.
- `gen_random_uuid()` exige extensão `pgcrypto` — a migration faz `CREATE EXTENSION IF NOT EXISTS pgcrypto;` no topo. **Confirmar extensão disponível na imagem PG 16 antes (devops).**
- **Por que seguro online:** colunas nullable + UPDATE idempotente; ninguém lê `tenant_id` ainda. Sem lock longo (PG 16 faz `ADD COLUMN` com default volátil como metadata change rápido; o backfill é `UPDATE` que toca poucas linhas — o volume é minúsculo, ~4-6 clones).
- **Gate de risco:** BAIXO. Não muda nenhum caminho de leitura/escrita em uso.
- **Validação:** `SELECT count(*) FROM <satelite> WHERE slot IS NOT NULL AND tenant_id IS NULL;` deve ser 0 para slots que existem em `flow_clones`. Linhas de slots de plataforma (sem `flow_clones`) ficam com `tenant_id NULL` — esperado, registrar.
- **Rollback:** `DROP COLUMN IF EXISTS tenant_id` (em release separado; nunca no mesmo). Nenhum dado de cliente perdido (só a coluna nova). O cabeçalho da migration 045 já traz o bloco de rollback explícito.
- **Apetite:** 1 dia (`backend-senior` escreveu; `devops-sre` confirma pgcrypto e aplica via pipeline; `qa-tester` valida contagem). **Implementado em `packages/db/migrations/045_tenant_id_nullable_backfill.sql` (PR #280).**

### Passo 2 — Dual-write (flag `TENANT_ID_DUAL_WRITE`) — **seguro online** — proposta (próximo PR)
- Provisioning de clone novo passa a gerar/carimbar `tenant_id`. INSERTs nas satélites passam a gravar `tenant_id` junto do `slot`. Leitura **continua** por `slot`.
- Atrás da flag: flag OFF = comportamento atual idêntico; flag ON = grava as duas chaves.
- **Por que seguro online:** só adiciona escrita de coluna já existente; leitura inalterada.
- **Gate de risco:** BAIXO-MÉDIO (toca caminho de provisioning — revisar com `qa-tester`).
- **Validação:** criar clone de teste com flag ON → `tenant_id` preenchido em todas as satélites tocadas. Re-rodar backfill do passo 1 pega qualquer linha escrita com flag OFF.
- **Rollback:** flag OFF. Dados já escritos ficam (são corretos).
- **Apetite:** 2 dias (`backend-senior`).

### Passo 3 — Cutover de leitura por `tenant_id` (flag `TENANT_ID_READ`) — **seguro online, validar em staging primeiro** — proposta
- Queries de **relatório/billing/analytics** passam a juntar/filtrar por `tenant_id`. Caminho de mensagem do bot **não muda** (continua por `slot`/sessão — menor risco no caminho quente).
- **Por que seguro online:** leitura por `tenant_id` é equivalente à leitura por `slot` depois do backfill validado (passo 1).
- **Gate de risco:** MÉDIO. Bug de junção = relatório errado (não derruba bot). Validar paridade `slot` vs `tenant_id` antes.
- **Validação:** rodar relatório nos dois modos (flag OFF vs ON) e diffar — devem bater linha a linha.
- **Rollback:** flag OFF (volta a ler por `slot`).
- **Apetite:** 2-3 dias (`backend-senior` + `frontend-engineer` se o relatório for de painel + `data-insights` para validar paridade).

### Passo 4 (FASE 2, ADR PRÓPRIO — NÃO neste release) — `NOT NULL` + FK + RLS — **exige janela curta + decisão Bruno** — proposta
- Só depois de semanas com dual-write estável e zero `tenant_id NULL` para clones válidos.
- `ALTER ... SET NOT NULL`, `ADD CONSTRAINT ... FOREIGN KEY (tenant_id) REFERENCES flow_clones(tenant_id)`, `ENABLE ROW LEVEL SECURITY` + policies.
- RLS muda o contrato de conexão (cada request seta `app.tenant_id`). Risco: request sem o set vê zero linhas. **Não decidir agora** — ADR 0021 futuro.
- **Apetite:** estimar no ADR da fase 2 (não agora).

---

## Validação (DoD deste ADR)
- Migration 045 idempotente: roda 2x sem erro, 2ª é no-op. ✅ (validado no PR #280)
- Pós-backfill: zero `tenant_id NULL` em satélites para slots presentes em `flow_clones`.
- `npm run build --workspaces` + `vitest` verdes.
- Relatório em modo `tenant_id` bate com modo `slot` (paridade) — Passo 3.
- Sessões WAHA intactas: nenhuma reconexão, nenhum restart de `automacoes-waha-1` (este pilar não toca WAHA).

## Rollback
- Passos 2-3: desligar flag → volta ao comportamento por `slot`.
- Passo 1 (já aplicado): `DROP COLUMN tenant_id` em migration de reversão separada (nunca no mesmo release). Como tudo é aditivo e nullable, reverter não perde dado de cliente. Bloco de rollback explícito no cabeçalho da migration 045.

## O que precisa de decisão/aprovação do Bruno
1. ~~**Aprovar a ancoragem em `flow_clones`**~~ ✅ APROVADO (Fase 1 mergeável em PR #280).
2. **Definir `tenant_id` de `startap` (Lola), `teste_barbearia` (matriz/router), `teste_vendas` e `teste_vendas_barbearia`**: seeds fixos ou fora do escopo de cliente. (Hoje ficam NULL — esperado.)
3. **Confirmar que RLS é fase 2 separada** (não entra neste release).
4. Aprovar os próximos PRs (dual-write, cutover) antes de o pipeline aplicar (deploy aplica migration sozinho — ver memória `reference_deploy_aplica_migrations`).

## Referências
- `packages/db/migrations/045_tenant_id_nullable_backfill.sql` — **execução da Fase 1 (PR #280)**: coluna nullable + backfill + índices + bloco de rollback.
- `packages/db/migrations/044_trial_ledger.sql` — template de aditivo idempotente + rollback.
- `packages/db/migrations/040_client_billing.sql:22`, `041_billing_charges.sql:36` — FK `slot → flow_clones(slot) ON DELETE CASCADE` (topologia reusada).
- `packages/db/src/queries/billing-charges.ts`, `client-billing.ts` — junção por `slot` hoje.
- ADR 0007 — isolamento de memória por `slot` no `session_id` (chat fica fora deste ADR).
- `scripts/migrate.sh` — runner idempotente, `schema_migrations`.
