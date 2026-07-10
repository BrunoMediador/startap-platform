# ADR 0023 — Conta multi-colaborador (estabelecimento): `product_type` + `clone_colaboradores`

- **Status:** ACEITO (em produção; documentado retroativamente — o código cita "ADR 0023" desde a Fase A / migrations 052-053, 2026-06-15). Drift de documentação corrigido em SCRUM-44.
- **Data:** 2026-07-10 (doc); decisão original ~2026-06-15 (`feat(estabelecimento): fundação tipo conta multi-colaborador atrás de flag — Fase A ADR 0023/0024`).
- **Autor:** 01-arquiteto
- **Aprovado por:** Bruno
- **Relacionados:** ADR 0006 (Google Calendar por clone — 1 SA por clone, caso individual), ADR 0007 (isolamento de memória por clone — `slot`), ADR 0018 (`tenant_id` por cliente — caminho RLS), ADR 0024 (agenda assistida / N calendarIds por colaborador — o **como** da agenda multi-colaborador; este ADR é o **modelo de conta**), ADR 0025 (pacotes — escopo casa/colaborador), ADR 0026/0027 (atendimentos/comissão por colaborador).

---

## Contexto

Até a Fase A todo clone era **individual**: 1 negócio = 1 agenda = 1 prestador (Cirilo, Samuel). Barbearias com **vários profissionais** (estabelecimento) precisam de um modelo diferente: cada barbeiro tem sua própria agenda, o cliente escolhe **com quem** agendar, e o dono contrata uma **faixa de vagas** (preço por barbeiro).

Isso introduz uma **fronteira de modelo de conta** nova sobre a âncora `flow_clones`. Restrições que moldam a decisão:

- **Não piorar nenhum pagante (P0).** Cirilo/Samuel são individual e não podem ser tocados — nem no schema, nem no runtime.
- **Sem ORM.** Migrations SQL raw idempotentes e aditivas (`scripts/migrate.sh`, versionadas por `schema_migrations`).
- **Isolamento (ADR 0018).** Toda linha nova carrega `slot` + `tenant_id UUID` desde o nascimento (caminho RLS futuro).
- **Reversibilidade.** Toda mudança aditiva/nullable, com rollback em release separada (regra de ouro 9).
- **Gating de rollout.** O caminho novo nasce DORMENTE atrás de flag (`ESTABELECIMENTO_ENABLED`, default OFF) — código novo só é alcançado com a flag ON **E** a conta sendo `estabelecimento`.

---

## Decisão

Introduzir o **tipo de conta** como coluna de primeira classe em `flow_clones` e uma tabela dedicada de profissionais, **100% aditivos e reversíveis**.

### §1 — Taxonomia de conta em `flow_clones` (migration 052)

- **`product_type VARCHAR(16) NOT NULL DEFAULT 'individual'`** — valores `individual | estabelecimento`. O `DEFAULT` carimba **implicitamente** toda linha existente como `individual` (backfill sem `UPDATE`, sem sobrescrever nada). Cirilo/Samuel intactos.
- **`seat_cap SMALLINT` (NULLABLE)** — teto de colaboradores da faixa contratada (ex.: 3/5/10). `NULL` = individual (sem teto, sem colaborador).

**A taxonomia é validada por Zod NO APP** (mesmo padrão da migration 051 de `area`), **NÃO por `CHECK` no banco** — assim o conjunto de tipos evolui sem nova migration.

### §2 — Enforcement no app, não no banco

O teto de vagas (`seat_cap`) é conferido **no app**, não por constraint: um `CHECK` não conhece a contagem de colaboradores ativos. O provisionamento do (N+1)-ésimo colaborador é barrado no runtime/gestão.

### §3 — Gating estrito (dormente por padrão)

O caminho estabelecimento só é alcançado sob **três portas em série** (ver `getGcalsForSlot`, `per-clone.ts:208`):

1. flag `ESTABELECIMENTO_ENABLED` OFF → caminho novo **inalcançável** (retorna vazio);
2. `slot` não começa com `clone_` → vazio (estabelecimento é SEMPRE `clone_`);
3. `product_type != 'estabelecimento'` → vazio (individual nunca entra no código novo).

Com qualquer porta fechada, o comportamento é **byte-a-byte** o de hoje. O caminho individual (`getGcalForSlot`) fica **100% independente** da flag.

### §4 — `clone_colaboradores` — profissionais do estabelecimento (migration 053)

Tabela NOVA. Cada linha carrega **`slot` (FK `flow_clones` `ON DELETE CASCADE`) + `tenant_id UUID`** desde o nascimento. Colunas-chave:

- `nome VARCHAR(160)`, `ativo`, `ordem` (desempate "primeiro disponível", Fase B);
- `gcal_calendar_id TEXT` (NULL até criar sob demanda — a agenda do colaborador é do ADR 0024);
- `gcal_status VARCHAR(16) DEFAULT 'pending'` (`pending|active|invalid|disabled`, validado no app).

**Isolamento e integridade:**

- `FK slot → flow_clones(slot) ON DELETE CASCADE` — deletar o clone remove os colaboradores junto (sem órfão);
- `UNIQUE(slot, lower(nome))` — impede homônimos no mesmo estabelecimento; **pré-requisito do roteamento por nome do bot ser determinístico**;
- `INDEX(slot)` + `INDEX(tenant_id)` — escopo de query por clone e por tenant.

**Sem backfill:** individual = **0 linhas** aqui. Nenhum pagante gera linha nesta tabela.

### §5 — Serviços por colaborador (migration 057)

`clone_colaboradores.servicos JSONB NOT NULL DEFAULT '[]'` — array de `servico_nome` que espelha `flow_clones.servicos[].nome`. `[]` = "não especificado" (não bloqueia agenda na Fase A; metadado de gestão + fallback para os serviços globais do clone). Adicionada em migration separada (053 já estava aplicada — regra de ouro 9).

### §6 — Superfície de gestão

- **Gestão (`painel-admin`):** CRUD de colaboradores, checklist de serviços por colaborador, geração de senha de login do colaborador, teste de agenda por colaborador (`server.js:983`, `:3778`, `:6191`, `:6632`). Criação/remoção de colaborador vivem SÓ no gestão.
- **Portal (dono):** o dono **LISTA e EDITA** colaboradores (renomeia, serviços, ativo, ordem) e vê uso de vagas, mas **NÃO cria nem remove** — o preço é por barbeiro e o operador pré-provisiona exatamente `seat_cap` vagas com agenda já conectada (`portal-equipe.ts:3`). Criar pelo portal geraria barbeiro sem agenda; remover apagaria o setup pré-provisionado.

---

## Alternativas consideradas

1. **`CHECK (product_type IN (...))` no banco.** Rejeitado: engessa a taxonomia (cada tipo novo = migration). Zod no app já valida e evolui sem DDL — mesmo padrão de `area` (051).
2. **Reusar `flow_clones` para o N-ésimo profissional (linha por barbeiro).** Rejeitado: quebra a âncora "1 clone = 1 negócio = 1 sessão WAHA" (ADR 0007), duplica config e billing B2B. `clone_colaboradores` é subordinada ao clone, não um clone novo.
3. **`seat_cap` como `CHECK`/constraint de contagem.** Impossível declarativamente (constraint não conta linhas de outra tabela por linha). Enforcement fica no app (§2).
4. **Ligar o caminho novo sem flag (só por `product_type`).** Rejeitado: sem kill-switch de rollout, um bug no caminho estabelecimento poderia afetar a leitura de qualquer clone. A flag `ESTABELECIMENTO_ENABLED` (default OFF) mantém tudo dormente até QA controlado.
5. **`servicos` do colaborador em tabela de junção `colaborador × servico`.** Adiado (Fase B). Na Fase A basta um metadado (`JSONB`) para o painel; a junção formal serviço×profissional no bot vem depois.

---

## Consequências

**Positivas:**

- Modelo de conta multi-colaborador com isolamento por `slot`+`tenant_id` desde o schema; individual **byte-idêntico** (default + gating triplo).
- Reversível: rollback = `DROP COLUMN`/`DROP TABLE` em release separada; nenhum pagante depende das colunas novas.
- Base para agenda por colaborador (ADR 0024), pacotes por escopo (ADR 0025) e comissão por profissional (ADR 0026/0027).

**Negativas / dívida aceita:**

- Enforcement de `seat_cap` no app (não no banco) — depende de disciplina de código; um bypass direto no PG estouraria o teto (mitigado: escrita passa pelo gestão/`@startap/db`).
- Homônimos são barrados por `UNIQUE(slot, lower(nome))` — dois "João" no mesmo estabelecimento exigem desambiguação de nome (decisão de produto; o teste adversarial de homônimos cobre o roteamento).
- App conecta como superuser do PG e RLS segue adiada (dívida P0 conhecida, [[db-app-superuser-rls-adiada]]); `tenant_id` já está gravado em `clone_colaboradores` para quando a RLS entrar.

---

## Critérios de aceitação (verificáveis)

1. **Isolamento de schema:** `clone_colaboradores` tem `slot`+`tenant_id NOT NULL` em toda linha; `FK ON DELETE CASCADE`; `UNIQUE(slot, lower(nome))`.
2. **Aditividade (não-destrutiva):** migrations 052/053/057 são `ADD COLUMN/CREATE TABLE IF NOT EXISTS`, sem `DROP/DELETE/TRUNCATE`, sem `NOT NULL` sem default, sem FK obrigatória nova; re-rodar é no-op.
3. **Roteamento determinístico:** dois colaboradores homônimos no mesmo slot são impossíveis (constraint) — o bot resolve o profissional sem ambiguidade.
4. **Byte-identidade do individual:** com `ESTABELECIMENTO_ENABLED` OFF **ou** `product_type='individual'`, o caminho de agenda é byte-a-byte o atual (Cirilo/Samuel inalterados).
5. **`schema_migrations`** incrementa +1 por migration aplicada (052, 053, 057).

---

## Referências de código (embasamento)

- `packages/db/migrations/052_flow_clones_product_type_seat_cap.sql` (`product_type`/`seat_cap`, taxonomia via Zod, §2/§consequências, critério de aceite 2)
- `packages/db/migrations/053_clone_colaboradores.sql` (tabela, `UNIQUE(slot, lower(nome))`, §4, critério de aceite 3)
- `packages/db/migrations/057_clone_colaboradores_servicos.sql` (`servicos JSONB`, §5)
- `apps/api/src/config.schema.ts:227` (flag `ESTABELECIMENTO_ENABLED`, Fase A dormente)
- `apps/api/src/bots/teste_barbearia.ts:539`, `:1305` (caminho estabelecimento Fase A)
- `packages/integrations/src/google-calendar/per-clone.ts:23`, `:123`, `:208` (gating estrito §3)
- `packages/db/src/queries/clone-colaboradores.ts:3` (queries dos colaboradores)
- `apps/portal-api/src/routes/portal-equipe.ts:3` (Fatia 1 do painel de estabelecimento)
- `painel-admin/server.js:983`, `:3778`, `:6191` (validação `product_type`/`seat_cap`, CRUD gestão)
- `painel-admin/test/clone-tipo-conta.test.js:5` (regra de taxonomia sob teste)
