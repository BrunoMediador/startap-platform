# ADR 0008: Tabela `bot_courses` e biblioteca de vídeos contextual

**Status:** proposta
**Data:** 2026-05-18
**Autor:** arquiteto
**Aprovado por:** Bruno (pendente)

---

## Contexto

O bot `teste_vendas_barbearia` já possui 5 mídias cadastradas em `bot_media` (todos `media_type='video'`). Atualmente, a tabela não tem o conceito de "curso" — os vídeos são posições planas sem agrupamento semântico. O produto evoluiu para ter múltiplos cursos por bot (ex: `curso-online-degrade`, `curso-presencial-barbearia`), cada um com vídeo de apresentação e vídeos de suporte.

O problema atual:

- O agente de IA não consegue distinguir qual vídeo pertence a qual curso ao responder perguntas do tipo "me mostra o curso de barbearia".
- Não há limite explícito de mídias por curso, tornando impossível validar consistência sem lógica ad-hoc no bot.
- O campo `context` em `bot_media` carrega texto livre sem estrutura de catálogo — difícil de manter e escalar para novos cursos.
- Clone factory (`packages/db/src/queries/flow-clones.ts`) copia `bot_media` mas não tem o conceito de curso para replicar.

Restrições relevantes:

- `bot_media` tem unique `(slot, position)` — a chave é textual, não sequencial.
- Clones em produção com `media_type` em uso não podem ter schema quebrado.
- A query `listBySlot` é consumida pelo cache de 30s dos bots — não pode ser alterada de forma incompatível.

---

## Decisão

Criamos uma tabela dedicada `bot_courses` com multi-tenancy por `slot`, seguindo o mesmo padrão de `bot_media` e `bot_config`. Adicionamos duas colunas nullable em `bot_media` (`course_slug`, `is_course_intro`) para vincular vídeos a cursos sem quebrar a interface existente. O limite de 5 mídias por curso é validado na camada de API (não via trigger ou constraint de banco). A relação entre `bot_media.course_slug` e `bot_courses(slot, course_slug)` é FK lógica (validada na API), não FK física, seguindo o padrão estabelecido no projeto. A clone factory é estendida para replicar `bot_courses` na mesma transação em que replica `bot_media`.

---

## Alternativas consideradas

### Opção A — Campo `course_slug` simples em `bot_media` sem tabela de catálogo

- **Como funcionaria:** adicionar apenas `course_slug text` nullable em `bot_media`. O agente infere metadados de curso a partir dos campos `context` e `caption` existentes.
- **Pros:** zero tabela nova; migration mínima.
- **Contras:** nome, descrição, preço e duração do curso ficam duplicados em cada vídeo. Inconsistência garantida ao editar. Sem suporte a curso sem vídeo ainda. Impossível listar cursos sem `DISTINCT` frágil.
- **Descartada porque:** duplicação de metadados em N linhas é anti-padrão claro; o painel precisaria de lógica complexa para editar nome do curso em um único lugar.

### Opção B — Coluna JSON `courses` em `bot_config`

- **Como funcionaria:** adicionar `courses jsonb` em `bot_config` com lista de objetos `{ slug, name, description, price, duration }`. `bot_media` ganha apenas `course_slug`.
- **Pros:** sem tabela nova; catálogo acessível junto ao config do bot.
- **Contras:** JSONB em Postgres não suporta unique constraint interna nem FK. Painel teria que fazer parse/serialize a cada edição de curso. Cresce acoplado ao `bot_config` que é lido por todo hot-path dos bots. Dificulta adição futura de campos por curso sem migration de schema.
- **Descartada porque:** viola o princípio de representar entidades de primeiro nível como tabelas; torna validação e edição incremental de cursos mais complexa sem ganho real de simplicidade.

### Opção C — Tabela dedicada `bot_courses` + colunas em `bot_media` + validação na API (ESCOLHIDA)

- **Como funcionaria:** `bot_courses(id, slot, course_slug, name, description, price, duration, position_order, enabled, created_at, updated_at)` com unique `(slot, course_slug)`. `bot_media` recebe `course_slug text nullable` e `is_course_intro boolean default false`. Constraint de unicidade de intro e limite de 5 mídias ficam na API. Clone factory replica `bot_courses` igual faz com `bot_media`.
- **Pros:** catálogo de cursos é entidade própria, editável de forma independente. Sem duplicação de metadados. Alinha com padrão multi-tenant do projeto (todas as tabelas usam `slot`). `bot_media` continua compatível para bots que não têm cursos (colunas nullable). Escalável para adicionar módulos, preços regionais, etc.
- **Contras:** adiciona tabela e duas colunas — migration mais longa. Clone factory fica mais complexa (mais uma cópia na transação). Validação do limite de 5 mídias na API pode ser contornada por acesso direto ao banco (risco operacional, não de segurança).
- **Escolhida porque:** é a única opção que suporta crescimento vertical (novos campos de curso) e horizontal (novos bots com cursos) sem refatoração global. Trade-off de complexidade é aceitável dado o isolamento que proporciona.

---

## Consequências

### Positivas

- Catálogo de cursos é editável via painel sem tocar em `bot_media`.
- Agente de IA pode consultar cursos estruturados: nome, preço, duração — sem depender de parse de texto livre.
- `GET /api/bots/:slot/courses` pode ser implementado sem query ad-hoc.
- Clones herdam catálogo de cursos da matriz automaticamente, mantendo isolamento.
- `bot_media` continua servindo bots sem cursos sem nenhuma mudança de comportamento — colunas nullable não afetam a query `listBySlot` existente.

### Negativas / trade-offs

- Clone factory ganha mais um bloco de cópia: mais surface de bug em caso de falha de transação (mitigado pelo ROLLBACK existente).
- Validação do limite de 5 mídias por curso na API significa que a regra não é enforced no banco. Um script externo ou migration futura mal escrita pode violar o limite silenciosamente.
- `upsertMedia` em `packages/db/src/queries/bot-media.ts` precisa ser estendida para incluir os dois novos campos — qualquer caller existente que não passe os campos novos recebe os defaults (`NULL` e `false`), o que é seguro mas deve ser auditado.
- `formatContextForPrompt` (linha 103 de `bot-media.ts`) retorna texto plano sem informação de curso — precisará de versão paralela ou evolução para incluir contexto de curso quando relevante.

### Neutras

- A FK lógica (validada na API, não no banco) é o padrão atual do projeto — `bot_media` também não tem FK física para `bot_config`. Não há regressão de consistência em relação ao estado atual.
- `price` armazenado como `integer` (centavos) é preferível a `numeric` para evitar arredondamento em cálculos. Conversão para reais ocorre na camada de apresentação.
- `duration` como `text` livre é adequado no estado atual (ex: "8 horas", "2 dias") — não há necessidade de `integer minutes` enquanto não houver lógica de cálculo automático.

---

## Plano de migração

Esta seção documenta a sequência de passos; o SQL real fica na missão de implementação.

1. **Migration DDL — `bot_courses`:** criar tabela `bot_courses` com os campos listados na decisão. Unique `(slot, course_slug)`. `NOT NULL` em `slot`, `course_slug`, `name`. Defaults: `position_order = 0`, `enabled = true`.

2. **Migration DDL — `bot_media`:** adicionar colunas `course_slug text` (nullable, sem default) e `is_course_intro boolean not null default false`. A constraint de unicidade de intro `(slot, course_slug) WHERE is_course_intro = true` implementada como unique partial index: `CREATE UNIQUE INDEX CONCURRENTLY uq_bot_media_course_intro ON bot_media (slot, course_slug) WHERE is_course_intro = true`. Index concurrente evita lock em produção.

3. **Migration DDL — regra `course_slug` implica `media_type='video'`:** implementada como check constraint: `ALTER TABLE bot_media ADD CONSTRAINT chk_course_slug_video CHECK (course_slug IS NULL OR media_type = 'video')`. Antes de aplicar, verificar que não há linha existente violando a regra.

4. **Seed de dados — `bot_courses` em `teste_vendas_barbearia`:** inserir 2 cursos com `slot = 'teste_vendas_barbearia'`:
   - `curso-online-degrade` — nome, descrição e preço definidos pelo product-owner na missão.
   - `curso-presencial-barbearia` — idem.

5. **Seed de dados — `bot_media` em `teste_vendas_barbearia`:** atualizar 3 linhas com o mapeamento:

   | `position` | `course_slug` | `is_course_intro` |
   |---|---|---|
   | `online_degrade_apresentacao` | `curso-online-degrade` | `true` |
   | `presencial_alunos_formados` | `curso-presencial-barbearia` | `true` |
   | `presencial_alunos_cortando` | `curso-presencial-barbearia` | `false` |
   | `demo_corte_degrade_1` | `NULL` | `false` (já é default) |
   | `demo_corte_degrade_2` | `NULL` | `false` (já é default) |

   As duas últimas linhas não precisam de UPDATE — já satisfazem os defaults.

6. **Migration idempotência:** toda migration usa `IF NOT EXISTS` para DDL e `ON CONFLICT DO NOTHING` ou `INSERT ... WHERE NOT EXISTS` para seeds. Pode ser re-executada sem efeito colateral.

7. **Extensão da clone factory** (`packages/db/src/queries/flow-clones.ts`): adicionar passo "3.5 — Copia bot_courses" entre a cópia de `bot_media` e o insert em `flow_controls`. Seleciona `course_slug, name, description, price, duration, position_order, enabled` da matriz e insere com o `slug` do clone. A cópia ocorre dentro da mesma transação existente — sem mudança no padrão de ROLLBACK.

8. **Extensão da clone factory — `bot_media`:** a query de seleção de `bot_media` na linha 144 de `flow-clones.ts` precisa incluir `course_slug, is_course_intro` no SELECT e no INSERT para preservar vínculos de curso no clone.

9. **API:** implementar `GET /api/bots/:slot/courses` e os endpoints de CRUD de cursos. Validação do limite de 5 mídias por `(slot, course_slug)` ocorre no handler de upsert de mídia, antes de persistir. Retornar erro HTTP 422 com mensagem clara ao atingir o limite.

10. **Painel:** escopo do dev-front — fora deste ADR.

---

## Validação

- Migration aplicada em staging sem erro; re-execução produz zero linhas afetadas (idempotência verificada).
- `SELECT * FROM bot_courses WHERE slot = 'teste_vendas_barbearia'` retorna exatamente 2 linhas após seed.
- `SELECT position, course_slug, is_course_intro FROM bot_media WHERE slot = 'teste_vendas_barbearia'` retorna mapeamento idêntico à tabela da seção "Plano de migração" passo 5.
- Unique partial index validado: tentativa de inserir segundo `is_course_intro = true` no mesmo `(slot, course_slug)` retorna erro de constraint.
- Check constraint validado: tentativa de inserir `bot_media` com `course_slug IS NOT NULL` e `media_type != 'video'` retorna erro de constraint.
- Clone de `teste_vendas_barbearia` criado via painel: `SELECT * FROM bot_courses WHERE slot = '<slug-do-clone>'` retorna os mesmos 2 cursos.
- `GET /api/bots/teste_vendas_barbearia/media` continua retornando as mesmas 5 mídias com os mesmos campos anteriores (regressão zero na interface existente).
- Tentativa de vincular 6ª mídia a um curso via API retorna HTTP 422.
- Build `tsc -b packages/db` passa sem erros após extensão de `BotMediaRow` e criação de `BotCourseRow`.

---

## Rollback

Se a feature precisar ser revertida após deploy em produção:

1. Reverter o código da clone factory e da API via PR de rollback (branch `revert/0008-bot-courses`).
2. Remover o unique partial index: `DROP INDEX IF EXISTS uq_bot_media_course_intro`.
3. Remover a check constraint: `ALTER TABLE bot_media DROP CONSTRAINT IF EXISTS chk_course_slug_video`.
4. Remover as colunas adicionadas: `ALTER TABLE bot_media DROP COLUMN IF EXISTS course_slug, DROP COLUMN IF EXISTS is_course_intro`.
5. Remover a tabela: `DROP TABLE IF EXISTS bot_courses`.

Passos 2–5 são DDL destrutivo e requerem aprovação explícita do Bruno antes de execução. Os dados de seed em `teste_vendas_barbearia` são perdidos — aceitável pois são dados de teste, não dados de cliente em produção. Clones criados após o deploy e antes do rollback terão `bot_courses` orfã que será removida no passo 5 via CASCADE implícito (a tabela não tem FK apontando para ela, então a limpeza é direta).

---

## Referências

- `packages/db/src/queries/bot-media.ts` — interface `BotMediaRow`, função `listBySlot`, `upsertMedia`
- `packages/db/src/queries/flow-clones.ts` — clone factory, linhas 134–154 (cópia de `bot_media`)
- ADR 0003 — padrão de roteamento de instâncias demo (multi-tenant por `slot`)
- ADR 0006 — Google Calendar por clone (padrão de replicação de config na clone factory)
