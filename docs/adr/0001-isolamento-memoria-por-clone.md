# ADR 0001: Isolamento de Memória por Clone via Coluna Discriminadora `scope_id`

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0001-isolamento-memoria-por-clone.md`
> **Quando usar:** decisão técnica de impacto — corrige P1 da Missão 001

---

**Status:** proposta
**Data:** 2026-05-17
**Autor:** arquiteto
**Aprovado por:** Bruno (pendente) — obrigatório antes de virar código

---

## Contexto

### Estado atual

Quando um clone é instanciado a partir de uma matriz (ex: `TesteBarbeariaBot` com `slotOverride = "barbearia_henrique"`), dois campos de `BotConfig` permanecem com o valor da matriz:

1. **`cfg.projectId`** — definido como a constante `SLOT` da classe da matriz (ex: `"teste_barbearia"`). Usado em `base.ts:196` para compor a chave de memória: `${cfg.projectId}:${sessao}:${flowId}:${telefone}`.
2. **`cfg.memoryTable`** — hardcoded no construtor de cada subclasse: `TesteBarbeariaBot` usa sempre `"chat_histories"`, `TesteVendasBot` usa `"chat_histories_ricardo"`, `TesteVendasBarbeariaBot` usa `"chat_histories_vendas_barbearia"`.

O getter `this.slot` em `base.ts:43-45` já retorna `slotOverride` corretamente para leitura de `bot_config`/`bot_prompt`/`bot_media`, mas **não é usado** em `memorySessionId()` (`base.ts:194-197`).

### Resultado concreto do bug

Dois clones distintos da mesma matriz que recebam mensagens do mesmo número de telefone (cenário de migração ou teste) compartilham exatamente a mesma chave de memória no banco. O histórico de um é lido pelo outro.

### Restrições relevantes descobertas na investigação

- **`KNOWN_CHAT_TABLES` em `packages/db/src/queries/chat-memory.ts:107-115`** é um Set estático em tempo de compilação. Qualquer nome de tabela fora dessa allowlist lança `Error: Tabela inválida` em runtime (linhas `appendMessage:66`, `loadHistory:38`, `pruneHistory:75`). Isso torna a Opção B (tabela dedicada por clone) bloqueante: exigiria migration dinâmica de `CREATE TABLE` por clone E expansão do allowlist, que é código.
- As matrizes de teste (`teste_barbearia`, `teste_vendas`, `teste_vendas_barbearia`, `startap`) não recebem `slotOverride` — portanto qualquer mudança que usa `slotOverride ?? cfg.projectId` é transparente para elas.
- A tabela `chat_histories` (usada por `TesteBarbeariaBot`) não tem coluna `scope_id` hoje. A alternativa C exige migration `ALTER TABLE ... ADD COLUMN`.
- Dados existentes em matrizes: session_id hoje no formato `teste_barbearia:sessao:flowId:telefone`. Nenhum clone de cliente está em produção ainda — não há dados históricos de clone a preservar.

### Por que isso é P1

Risco de LGPD e churn: cliente A e cliente B (clones da mesma matriz) compartilham contexto de conversa se o mesmo número de telefone interagir com os dois. O PR-FAQ da Missão 001 documenta o cenário de vazamento.

---

## Decisao

**Substituir `cfg.projectId` por `this.slot` (que já resolve `slotOverride ?? cfg.projectId`) como discriminador na chave de memória, mantendo a tabela compartilhada da matriz e sem nenhuma migration de schema.** O `memoryTable` permanece o da matriz (sem mudança), e o isolamento é garantido integralmente pelo `projectId` efetivo que já faz parte da chave composta de `session_id`.

Em termos precisos: a linha `base.ts:196` passa de `${this.cfg.projectId}:...` para `${this.slot}:...`. Isso requer mudança em um único local de `base.ts` e nenhuma alteração em schema, allowlist ou subclasses.

---

## Alternativas consideradas

### Opção A — Prefixo de chave de memória por slot (mesma tabela, scoping na chave) — ESCOLHIDA

- **Como funcionaria:** Em `base.ts:196`, substituir `this.cfg.projectId` por `this.slot`. O getter `slot` já retorna `slotOverride ?? cfg.projectId`. A chave de memória para um clone `barbearia_henrique` passaria a ser `barbearia_henrique:sessao:flowId:telefone` em vez de `teste_barbearia:sessao:flowId:telefone`. Nenhuma mudança no schema, no allowlist de tabelas, nem nas subclasses.
- **Pros:**
  - Mudança cirúrgica: 1 linha em `base.ts:196`.
  - Zero migration de banco.
  - Não quebra matrizes (para elas, `slotOverride` é `undefined`, então `this.slot` retorna `cfg.projectId` — comportamento idêntico ao atual).
  - Não toca `KNOWN_CHAT_TABLES` nem `memoryTable`.
  - `run-agent.ts:67` passa `projectId: this.slot` em algumas subclasses (ex: `teste_barbearia.ts:309`, `teste_vendas.ts:170`, `teste_vendas_barbearia.ts:426`) — consistente com a decisão.
  - Rollback imediato: reverter 1 linha.
- **Contras:**
  - Não isola fisicamente: dados de clones diferentes ficam na mesma tabela, separados apenas pela chave. Para volumes altos (centenas de clones), a tabela cresce sem particionamento.
  - Sem coluna `scope_id`, queries de auditoria por clone exigem `LIKE 'barbearia_henrique:%'` — menos eficiente do que um índice em coluna dedicada.
- **Escolhida porque:** resolve o bug de isolamento com risco mínimo e é reversível. O volume atual (poucos clones, memória de chat é leve) não justifica complexidade adicional de schema. Escala pode ser endereçada em ADR futuro se necessário.

---

### Opção B — Tabela dedicada por clone (`chat_histories_<slot>`)

- **Como funcionaria:** Ao criar um clone no painel, provisionar uma nova tabela `chat_histories_<slotOverride>` via migration dinâmica. `memoryTable` no `BotConfig` do clone recebe esse nome. `KNOWN_CHAT_TABLES` precisaria aceitar a tabela em runtime.
- **Pros:**
  - Isolamento físico máximo: DELETE/TRUNCATE de um clone não afeta outros.
  - Queries de auditoria simples (toda a tabela é de um cliente).
- **Contras:**
  - **Bloqueante imediato:** `KNOWN_CHAT_TABLES` é um Set estático compilado. Adicionar tabelas em runtime exige refatorar o allowlist para um registro dinâmico — mudança de escopo que ultrapassa a Missão 001.
  - Exige migration dinâmica por clone (`CREATE TABLE IF NOT EXISTS`) — infraestrutura não existe hoje.
  - Proliferação de tabelas: 50 clones = 50 tabelas adicionais. Sem automação de cleanup, tabelas orfãs persistem indefinidamente.
  - Viola o princípio de zero migration para esta decisão.
- **Descartada porque:** o bloqueio no allowlist estático exige refatoração fora do escopo desta missão. Risco alto, ganho marginal para o volume atual.

---

### Opção C — Coluna discriminadora `scope_id` na tabela compartilhada

- **Como funcionaria:** Adicionar coluna `scope_id TEXT DEFAULT NULL` em cada tabela `chat_histories*`. Queries de `loadHistory`, `appendMessage`, `pruneHistory` adicionariam `WHERE scope_id = $n` (ou `IS NULL` para matrizes). `memoryTable` continuaria da matriz; o isolamento viria pela coluna.
- **Pros:**
  - Isolamento explícito por coluna — queries de auditoria diretas.
  - Compatível com dados existentes (matrizes ficam com `scope_id = NULL`).
  - Não prolifica tabelas.
- **Contras:**
  - Exige migration `ALTER TABLE` em 7 tabelas `chat_histories*` (mais quaisquer futuras).
  - Exige alterar as assinaturas de `appendMessage`, `loadHistory`, `pruneHistory` em `packages/db` — mudança de interface do pacote compartilhado que afeta todas as subclasses.
  - Mais linhas de mudança do que a Opção A para o mesmo resultado de isolamento.
  - Matrizes precisariam passar `scope_id = null` explicitamente — risco de regressão se alguma chamada esquecer o parâmetro.
- **Descartada porque:** custo de migration + mudança de interface de `packages/db` é desproporcional ao ganho sobre a Opção A para o volume atual. Pode ser fase 2 se escala exigir índice dedicado por clone.

---

### Opção D — `scope_id` apenas como prefixo no `session_id` (híbrido A+C sem migration)

- **Como funcionaria:** Variação da Opção A: em vez de apenas trocar `projectId` por `this.slot`, reformatar a chave como `scope:<slot>:<resto>` para diferenciar visualmente clones de matrizes nos dados. Sem nova coluna.
- **Pros:** Distinguível via LIKE para auditoria.
- **Contras:** Quebra compatibilidade com dados existentes de matrizes (que hoje têm `teste_barbearia:...` sem prefixo `scope:`). Exigiria lógica de fallback de leitura para não perder histórico atual — complexidade desnecessária dado que `this.slot` para matrizes já retorna o mesmo valor que `cfg.projectId`.
- **Descartada porque:** a Opção A resolve o problema sem introduzir incompatibilidade de formato de chave.

---

## Consequencias

### Positivas

- Cada clone passa a ter chave de memória `<slotOverride>:sessao:flowId:telefone` — colisão impossível entre clones de matrizes diferentes e entre clones da mesma matriz (desde que tenham `slotOverride` distintos, o que é garantido pelo painel).
- Matrizes não são afetadas: `this.slot` retorna `cfg.projectId` quando `slotOverride` é `undefined`.
- Mudança de 1 linha com rollback imediato.
- Nenhum downtime: a chave nova começa a ser usada na primeira mensagem pós-deploy; histórico antigo (se houver) fica preservado na chave antiga sem ser apagado.

### Negativas / trade-offs

- Dados de diferentes clones continuam na mesma tabela física. Para auditoria por clone, é necessário query com `LIKE '<slotOverride>:%'` no `session_id`.
- Se o `slotOverride` de um clone for alterado após criação (caso de rename de slug), o histórico com a chave anterior fica "órfão" — não será carregado. Mitigação: o painel não deve permitir rename de slug de clone ativo (restrição operacional, não técnica).

### Neutras (vale registrar)

- `run-agent.ts` já passa `projectId: this.slot` nas chamadas do agente em `teste_barbearia.ts`, `teste_vendas.ts` e `teste_vendas_barbearia.ts`. A mudança em `base.ts` alinha `memorySessionId()` com o que o agente já usa como `projectId` — sem divergência.
- Logs em `base.ts:111` e `base.ts:141` ainda exibem `projectId: this.cfg.projectId` (slot da matriz). O arquiteto recomenda que o `dev-back` também atualize esses campos de log para `this.slot` para facilitar debugging, mas isso não é requisito de isolamento.

---

## Plano de migracao

Matrizes não usam `slotOverride`, portanto não há dados em chave de clone a migrar hoje.

1. **Sem migration de schema.** Nenhuma alteração em tabelas `chat_histories*`.
2. **`base.ts:196`** — substituir `this.cfg.projectId` por `this.slot`. Verificar que `this.slot` é `readonly` e acessível no método privado (getter `protected` — confirmar visibilidade).
3. **(Opcional, recomendado)** Atualizar campos de log em `base.ts:111` e `base.ts:141` de `this.cfg.projectId` para `this.slot` para consistência de observabilidade.
4. **Validar compilacao:** `npm run build --workspaces` deve passar sem erros.
5. **Deploy:** mudança é compatível com dados existentes. Não há clones em produção hoje, portanto nenhuma chave legada de clone a considerar.

Ordem de arquivos a tocar pelo `dev-back`:

| Ordem | Arquivo | Mudanca |
|-------|---------|---------|
| 1 | `apps/api/src/bots/base.ts:196` | `this.cfg.projectId` → `this.slot` na montagem de `memorySessionId` |
| 2 (opcional) | `apps/api/src/bots/base.ts:111,141` | `projectId: this.cfg.projectId` → `projectId: this.slot` nos metadados de log |

Nenhum outro arquivo precisa ser alterado para satisfazer o DoD da Missão 001.

---

## Validacao

- **Teste de compilação:** `npm run build --workspaces` passa sem erros de tipo.
- **Teste de isolamento (smoke manual):** enviar mensagem para clone A (`slotOverride = "barbearia_henrique"`) e clone B (`slotOverride = "barbearia_joao"`) com o mesmo número de telefone. Verificar no banco que `session_id` das entradas em `chat_histories` começa com `barbearia_henrique:` e `barbearia_joao:` respectivamente — não com `teste_barbearia:`.
- **Teste de regressão de matrizes:** enviar mensagem para `teste_barbearia` (sem `slotOverride`). Verificar que `session_id` continua com prefixo `teste_barbearia:` — comportamento inalterado.
- **Critério de log:** após deploy, `flow_execution_logs` com `eventType = 'bot.memory-human'` e `metadata.projectId` de um clone devem conter o `slotOverride`, não o slot da matriz.

---

## Rollback

A mudança é de 1 linha e sem migration de schema. Rollback = reverter `base.ts:196` para `this.cfg.projectId` e fazer novo deploy. Dados gravados com a chave nova não são apagados — ficam preservados na tabela, apenas inacessíveis até que a chave nova seja restaurada.

---

## Referencias

- Missão 001: `docs/missoes/001-isolamento-memoria-clones.md`
- Bug identificado em: `apps/api/src/bots/base.ts:196`
- Allowlist de tabelas: `packages/db/src/queries/chat-memory.ts:107-115`
- Getter `slot`: `apps/api/src/bots/base.ts:43-45`
- Factory de clones: `apps/api/src/router.ts:45-57`, `apps/api/src/server.ts:37-40`
