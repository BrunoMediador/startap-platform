# ADR 0033 — Cartão de confirmação montado em RUNTIME (increment 2 do ADR 0032)

- **Status:** **Aceito** — em PRODUÇÃO desde 2026-07-23 (migration 075 aplicada 02:40 UTC;
  `CARTAO_RUNTIME_ENABLED=true` em `startap-api` e `startap-portal-api`).
- **Data:** 2026-07-23
- **Autor:** 01-arquiteto
- **SCRUM:** SCRUM-92 (entrega, increment 2) / SCRUM-119 (este registro)
- **Relacionados:** ADR 0032 (builder conversacional — este ADR ENTREGA o "increment 2" que lá
  estava marcado como fora do MVP), ADR 0023 (estabelecimento multi-colaborador), ADR 0030
  (gates env→coluna), SCRUM-83 (persona sticky / `prompt_custom`), SCRUM-84 (emojis por área),
  SCRUM-99 (fonte única `cartaoLinhas*`), SCRUM-113 (raiz: `modo_atendente_enabled` divergente),
  SCRUM-81 (dívidas de sanitize).

> **Este ADR é registro do ENTREGUE, não plano.** Foi escrito depois do rollout, com o código na
> `main` e o estado de produção conferido. Onde a entrega divergiu do plano de 22/07, a divergência
> está anotada em "O que mudou em relação ao plano".

---

## Contexto

O **cartão de confirmação** — o bloco que o bot manda antes de marcar (`DIA/HORÁRIO/SERVIÇO/VALOR` +
"Responda SIM para confirmar") e a regra de exigir SIM antes de `inserir_agendamento` — é a mecânica
central do produto. Até 23/07 ele existia em **duas naturezas incompatíveis**:

1. **BAKED** no caminho individual: texto persistido dentro de `bot_prompt` (dado), gravado no
   onboarding e re-gravado a cada re-render do template. É **dado do cliente**, logo mutável por
   qualquer caminho que escreve prompt (gestão, portal, builder).
2. **CÓDIGO** no caminho estabelecimento: `buildCartaoEstabelecimentoBlock`, injetado no
   `systemPrompt` a cada turno.

Isso gerava três problemas concretos:

- **Durabilidade:** um PUT de prompt no gestão, um rollback de versão ou um re-render podia **dropar
  o cartão calado** de um clone individual — o bot passava a marcar sem confirmar e ninguém via.
  O ADR 0032 (builder) mitigou colando o `BLOCO_ESTRUTURAL` por código no `approve`, mas o resultado
  continuava sendo **texto persistido** — ou seja, mitigação, não garantia.
- **Colisão builder × estabelecimento:** um clone de estabelecimento que passasse pelo builder
  ganhava o cartão INDIVIDUAL baked no `bot_prompt` **somado** ao cartão de estabelecimento do
  runtime = dois cartões conflitantes. Latente, mas real (fechado interinamente na PR #472).
- **Customização impossível:** o dono não podia escolher layout/ícones do cartão sem editar o
  prompt à mão, e editar à mão é exatamente o que quebra a mecânica.

A tensão que impedia a solução óbvia: **Cirilo e Samuel** são pagantes com `systemPrompt`
byte-a-byte congelado (golden test). Qualquer mudança global no assembly do prompt os toca.

## Decisão

### 1. O RUNTIME vira a fonte única da mecânica de agendamento — por MODO REAL

O cartão + a regra do SIM passam a ser montados por **código**, em runtime, a cada turno, nos **três**
pontos de injeção do `apps/api/src/bots/teste_barbearia.ts` — um por **MODO REAL** do runtime:

| Modo real | Ponto de injeção | Cartão |
|---|---|---|
| individual (agenda) | `teste_barbearia.ts:~694` | `buildCartaoRuntimeBlock({ modo:'agenda' })` |
| estabelecimento | `teste_barbearia.ts:~1505` | `buildCartaoRuntimeBlock({ modo:'estabelecimento' })` (linha 👤 PROFISSIONAL) |
| atendente (pré-venda) | `teste_barbearia.ts:~1070` | `''` **por construção** — atendente não marca horário, logo não tem cartão |

"Modo REAL" é literal e carrega a lição do incidente (abaixo): o modo é o que o **runtime** decide,
não o que uma coluna de flag diz. A fonte única do bloco é
`packages/integrations/src/prompt-builder/bloco-estrutural.ts` (`buildCartaoRuntimeBlock`,
`resolveEmojis`, `cartaoLinhas*`) — a mesma que o `approve` do builder e a prévia do portal (SCRUM-99)
usam. **A IA nunca escreve a mecânica; o dono nunca desabilita** (`canDisable:false` no contrato).

### 2. Governança em DOIS níveis: coluna por-clone ∧ gate global

- **`flow_clones.cartao_mode`** (`text` + `CHECK IN ('baked','runtime')`, **DEFAULT `'baked'`**):
  - `baked` — comportamento de HOJE, `systemPrompt` **byte-a-byte** idêntico. Protege Cirilo/Samuel.
  - `runtime` — `bot_prompt` guarda **só a persona**; o runtime injeta o cartão e aplica
    `flow_clones.cartao_config`.
- **`CARTAO_RUNTIME_ENABLED`** (env, `apps/api` + `apps/portal-api`) — gate global.

O gate é **duplo e conjuntivo** no caminho do bot: `CARTAO_RUNTIME_ENABLED && cartao_mode==='runtime'`.
Com a coluna em `baked` (todo mundo, no dia do flip), ligar a flag tem **efeito zero**.

### 3. Migration `075_flow_clones_cartao_config.sql` — aditiva, dormente, sem backfill

`ADD COLUMN IF NOT EXISTS cartao_mode TEXT NOT NULL DEFAULT 'baked' CHECK (...)` +
`ADD COLUMN IF NOT EXISTS cartao_config JSONB` (NULL = usar defaults por área). O DEFAULT carimba
toda linha existente no próprio `ALTER` — **backfill implícito, nenhum dado de cliente tocado**.
`cartao_mode` é `text`+CHECK (não boolean) para admitir um `'hybrid'` futuro sem trocar tipo;
`cartao_config` é JSONB validado no app (padrão das migrations 051/068, casa não tem ORM).
Aplicada em produção em **2026-07-23 02:40 UTC**; é a última linha de `schema_migrations`.

### 4. Rollout por **flip-on-customize** — ninguém é force-migrado

Decisão de produto (Bruno, 23/07) que substituiu a "migração opt-in por lote" do plano:

- A tela **aparece pra TODO cliente**, já **semeada com o cartão atual dele**.
- Quem **não salvar** segue `baked`, byte-a-byte igual — inclusive para sempre.
- Quem **salvar uma mudança** tem **só o clone dele** flipado pra `runtime`, com a escolha dele, na
  MESMA transação (`migrateCloneToCartaoRuntime`).

O flip preserva o cartão legado **VERBATIM**: `cartao_config.verbatim` guarda a captura literal do
cartão que aquele clone já tinha, e `buildCartaoRuntimeBlock` emite esse texto **exato** com
precedência sobre o montado. O cartão só troca de "assado" para "injetado" — byte-idêntico. Só quando
o dono edita é que o app grava um config sem `verbatim` e o cartão passa a ser montado.

Estados do endpoint `GET/PUT /portal/cartao-config` (`apps/portal-api/src/routes/portal-cartao-config.ts`):

| Estado do clone | Comportamento |
|---|---|
| `cartao_mode='runtime'` | editável; ajusta config, **não** re-flipa |
| `baked` + `prompt_custom=true` | **LOCKED** (`locked_reason='prompt_custom'`), PUT → **409** — nunca flipa persona editada à mão sem revisão |
| `baked` + `prompt_custom=false` + cartão **flip-safe** (`isCartaoFlipSafe`) | editável; PUT **flipa** aquele clone |
| `baked` + extração não-confiável | `locked_reason='requer_revisao'`, PUT → **422**; caminho supervisionado = `scripts/migrate-cartao-runtime.ts` |

A PR #481 fez o **formato template LEGADO** (`[CARTAO DE CONFIRMACAO]` dos clones Cirilo/Samuel/mvs)
passar a ser reconhecido como flip-safe — fim do "fale com o suporte" para esses donos.

**Reversão do flip:** `migrateCloneToCartaoRuntime` grava snapshot do `bot_prompt` baked em
`bot_prompt_versions` (`CARTAO_MIGRATION_SNAPSHOT_COMMENT`); reverter é
`npx tsx scripts/migrate-cartao-runtime.ts --revert <slot>` (restaura o baked + `cartao_mode='baked'`
+ `cartao_config=NULL`).

### 5. Invariante anti-cartão-duplo, forçada na camada de dados

`packages/db/src/queries/bot-prompt.ts` **aborta a transação** se `cartaoMode:'runtime'` vier com um
`finalPrompt` que ainda contém o marcador do cartão baked (`bakedMarker`). Um clone `runtime` não
pode ter cartão no `bot_prompt` — o guard prova isso no ponto de escrita, não por convenção.

### 6. Segurança: allowlist FECHADA de code points para o emoji

O emoji escolhido pelo dono é **interpolado no `systemPrompt` do bot**. Validar por "categoria
Unicode + limite de grapheme cluster" é **insuficiente**: um grapheme carrega code points ilimitados,
e **tag characters U+E0020–U+E007E** (ASCII invisível), variation selectors (U+FE00–FE0F,
U+E0100–E01EF) e ZWJ **contrabandeiam instrução** que o LLM decodifica e obedece.

Como o campo é um **picker de catálogo finito**, a decisão foi **allowlist fechada de sequências
exatas** (`packages/integrations/src/prompt-builder/cartao-catalog.ts`, `validateCartaoEmojis`):
NFC → comparar a **sequência inteira** contra o `Set` do catálogo daquela chave → rejeitar o resto
(400). `template` é enum fechado. `slot` vem SEMPRE da sessão (`withTenant`), nunca do body (anti-IDOR,
regra de ouro 5).

## Rollout que efetivamente aconteceu

| PR | O que entregou |
|---|---|
| #472 | Fase 0 — variante estabelecimento no cartão BAKED (fecha a colisão latente do builder) |
| #473 | Fundação: migration 075 + flag OFF + **golden byte-a-byte** (`systemprompt-baked-barbearia.golden.txt`) |
| #474 | Injeção em runtime nos 3 caminhos — **dormente**, gate duplo, golden verde |
| #475 | Ativação: endpoint `GET/PUT /portal/cartao-config` + `scripts/migrate-cartao-runtime.ts` + approve nasce runtime — gated OFF |
| #476 | Flip-on-customize (UI pra todos, sem force-migração); flip arma `prompt_custom=true`, `--revert` desarma |
| #477 | Tela "Cartão de confirmação" em Meu negócio |
| #480 | **Correção do incidente** — builder passa a usar o MODO REAL do runtime e a honrar `cartao_mode='runtime'` |
| #481 | Formato template legado vira flip-safe (`isCartaoFlipSafe`) — fim do "fale com o suporte" |

**No flip da flag para ON, 6/6 clones seguiram `baked`** — nenhum cliente mudou de comportamento no
momento da ativação, exatamente como o gate duplo previa.

**Estado de produção conferido em 2026-07-23:**

| Clone | `cartao_mode` | `cartao_config` |
|---|---|---|
| ingrid | `runtime` | `{template, emojis}` |
| dragon | `runtime` | NULL (defaults por área) |
| cirilo, samuel, meduzza, mvs | `baked` | NULL |

## O que mudou em relação ao plano

O plano do arquiteto é de 22/07, escrito ANTES da implementação. Divergências relevantes entre plano
e entrega, para quem for mexer nisto depois:

1. **`cartao_config.verbatim` NÃO existia no plano.** O plano previa `{template, emojis}`. O
   refinamento do Bruno (23/07) acrescentou a captura LITERAL do cartão legado, com **precedência**
   sobre o montado. É o que torna o flip invisível para o cliente final — passou a ser a peça central
   do rollout, não um detalhe.
2. **"Migração opt-in por lote com diff-guard" (Fase 4 do plano) virou flip-on-customize por
   auto-serviço.** Quem migra é o DONO, ao salvar na tela, um clone por vez. O script
   `migrate-cartao-runtime.ts` continua existindo, mas como caminho **supervisionado** para os casos
   que o endpoint recusa (`requer_revisao`, `--allow-template`), não como o mecanismo principal.
3. **O plano dizia "Cirilo/Samuel NÃO migram".** A PR #481 tornou o formato template legado deles
   **flip-safe** — eles PODEM migrar se o dono salvar na tela. Seguem `baked` porque ninguém salvou,
   não porque estão bloqueados. A frase do plano deixou de ser uma trava e virou uma expectativa.
4. **A aresta `prompt_custom=true` foi fechada em UM dos dois caminhos.** O plano exigia
   "bloquear OU reconciliar clones `prompt_custom=true` antes de virar runtime". O **endpoint**
   bloqueia (409). O **approve do builder** não: ele seta `prompt_custom=true` E
   `cartao_mode='runtime'` na mesma transação — foi por aí que a Ingrid (`prompt_custom=true`, cartão
   🌻 feito à mão) virou `runtime`. O que segura ali não é um bloqueio, é o guard `bakedMarker`
   (§5), que aborta se o cartão baked sobreviver no `finalPrompt`.
5. **"Rollback: env OFF + restart" (plano) está ERRADO hoje.** Era verdade enquanto todos eram
   `baked`. Ver a nota de OPS abaixo: a flag virou load-bearing no instante do primeiro flip.
6. **O plano não previu o incidente do modo.** Ele tratava o modo do clone como dado resolvido; a
   entrega descobriu (do jeito caro) que há duas fontes de verdade divergentes. Ver abaixo.
7. **Itens do plano que a entrega cumpriu como pedido:** MVP interino de estabelecimento (#472),
   invariante anti-cartão-duplo na mesma transação (#475), golden byte-a-byte do 1º clone runtime
   (#474/#476), `nomeNegocio` cabeado nos call-sites (deixou de ser placeholder), allowlist fechada
   de emoji no PUT.

## Consequências

### Positivo

- A mecânica de agendamento deixa de ser dado mutável e vira **código re-injetado a cada turno**:
  para clones `runtime`, nenhum PUT/rollback/re-render de prompt consegue mais dropar o cartão.
- Fonte única do cartão entre bot, `approve` do builder e prévia do portal — o dono vê exatamente o
  que o cliente recebe (SCRUM-99), sem drift.
- Customização virou **dado cosmético** (`template`+`emojis`) sobre um esqueleto de código: o dono
  personaliza sem poder de quebrar a regra do SIM.
- Rollout com blast radius zero na ativação (gate duplo + default `baked` + verbatim).
- Reversível por clone (`--revert`) via snapshot durável.

### ⚠️ NOTA DE OPS — `CARTAO_RUNTIME_ENABLED` é **LOAD-BEARING**, não é mais kill-switch

Enquanto todos os clones estavam `baked`, desligar a flag era seguro (todos voltavam ao assado).
**Isso deixou de valer no instante em que o primeiro clone virou `runtime`.** Hoje:

> **Desligar `CARTAO_RUNTIME_ENABLED` com clones em `cartao_mode='runtime'` os deixa SEM cartão de
> confirmação.** O cartão baked foi REMOVIDO do `bot_prompt` desses clones, e a injeção em runtime
> fica gated OFF. Resultado: bot marca sem confirmar. Hoje isso atinge **ingrid e dragon**.

Rollback correto **não é** a flag: é `scripts/migrate-cartao-runtime.ts --revert <slot>` por clone
(restaura o baked do snapshot), e só então, se for o caso, a flag. Flag de rollout tem prazo de
validade — no momento em que o primeiro registro migra, ela para de ser reversível.

### Consequência NÃO-prevista — incidente de 2026-07-23 (~2h39min sem o guard)

O builder resolvia o modo do clone pela **coluna de flag** (`modo_atendente_enabled` /
`MODO_ATENDENTE_SLOTS`) em vez do **modo REAL do runtime**. O runtime só entra no ramo ATENDENTE
quando a flag está ON **E** `agenda_automatica` está explicitamente OFF
(`teste_barbearia.ts:524-537`). O clone da **Ingrid** (pagante) tem a flag atendente setada mas roda
**AGENDA** — o builder assou nela o bloco de **atendente (sem cartão)**, deixando-a **~2h39min sem o
guard de agendamento**.

Correção (PR #480): o builder passou a espelhar exatamente a decisão do runtime —

```
reallyAtendente = modoAtendenteFlag && !isAgendaAutomaticaIntent(clone.personalizacao?.agenda_automatica)
```

— e a **honrar** `cartao_mode='runtime'` mesmo com a flag global OFF (`CARTAO_RUNTIME_ENABLED ||
ctx.cartaoMode === 'runtime'`), para nunca re-assar um segundo cartão num clone já migrado. O dado
corrompido foi corrigido por SQL manual.

**A raiz permanece aberta:** existem DUAS fontes de verdade para "este clone é atendente?" — a coluna
`modo_atendente_enabled` e o gate real do runtime (`flag && !agenda`). Corrigir só o consumidor que
quebrou deixa a raiz viva; o mesmo clone já mordeu 2× (SCRUM-87 em 17/07, este incidente em 23/07).
O fix arquitetural é derivar o modo de UMA função compartilhada e fazer todos os consumidores
chamarem ela — **SCRUM-113**.

### Negativo / dívida aceita

- **Byte-a-byte × durabilidade são mutuamente exclusivas por clone.** Cirilo/Samuel seguem `baked`
  **por escolha** (ninguém salvou na tela) — portanto seguem sem a garantia de durabilidade. Não
  estão mais bloqueados (PR #481 os tornou flip-safe); é decisão de não mexer, não impedimento.
- **Assimetria de validação (SCRUM-81):** a allowlist fechada roda **só no PUT**. O RENDER
  (`packages/db/src/queries/clone-colaboradores.ts`, `parseCartaoConfig`) aceita **qualquer string**
  vinda do banco no campo emoji. Quem escrever direto no banco (operador, script, SQL manual)
  contorna a allowlist e injeta texto no `systemPrompt`. Superfície hoje = quem já tem acesso ao
  banco, mas a defesa em profundidade está faltando no lado do render.
- **`nome_negocio` é injetado no cartão runtime sem sanitize** (`resolveNomeNegocio` → `blocoAgenda`).
  É campo livre do dono que entra no `systemPrompt` (SCRUM-81).
- **Zero conversa real passou pelo cartão injetado ainda.** Ingrid e dragon estão em `runtime`, mas
  não houve tráfego de agendamento validado por esse caminho. A prova hoje é golden + testes, não
  produção observada. Primeira conversa real dos dois merece verificação ativa.
- Comentários de código ainda diziam "OFF em prod" (corrigidos nesta PR — ver Notas).

## Alternativas consideradas

1. **Manter tudo baked e blindar só o `approve` (status quo do ADR 0032).** Rejeitado: mitiga, não
   garante — o cartão continua sendo dado e qualquer caminho de escrita de prompt pode dropá-lo.
2. **Migrar TODOS os clones para runtime de uma vez (force-migration).** Rejeitado: quebra o
   byte-a-byte de pagantes num único passo, sem consentimento do dono e sem prova por conversa real.
   O flip-on-customize dá o mesmo destino com blast radius de 1 clone por vez e decisão do dono.
3. **Boolean `cartao_runtime` em vez de `text`+CHECK.** Rejeitado: fecha a porta para um terceiro
   estado (ex.: `hybrid`) sem migration de tipo; o CHECK dá validação forte no schema, que é onde
   ela precisa estar numa casa sem ORM.
4. **Montar o cartão do zero no flip (sem `verbatim`).** Rejeitado: mudaria o texto que o cliente
   final já recebe, no ato do flip, sem o dono ter pedido. `verbatim` torna o flip invisível.
5. **Validar emoji por categoria Unicode / limite de grapheme cluster.** Rejeitado por insuficiência
   demonstrada (tag chars, VS, ZWJ). A alternativa de fallback (cap por scalar ≤2 + rejeição de tag
   block/VS/ZWJ/Cf/Mn-Mc/BiDi) só faria sentido se um dia exigirem emoji arbitrário — é estritamente
   pior de manter que um catálogo fechado.
6. **`cartao_config` em tabela própria.** Rejeitado: é propriedade 1:1 durável do clone; `flow_clones`
   já é a âncora do tenant. Tabela nova seria join a mais no hot path sem ganho.

## Notas de implementação

- **Zero read novo no hot path:** `cloneColaboradores.getAreaPromptCustomCartao(slot)` é a MESMA
  leitura por slot que `getAreaAndPromptCustom` já fazia, com 2 colunas a mais (`cartao_mode`,
  `cartao_config`) — 1 query por PK. Fallbacks deliberados e **byte-seguros** (coluna ausente, linha
  ausente, erro de query → NUNCA lança → `cartaoMode='baked'`): mesmo sem a 075 aplicada, o bot cai
  no caminho de hoje.
- **Redes de segurança:** `apps/api/src/bots/systemprompt-golden.test.ts` congela o baseline `baked`
  byte-a-byte; `apps/api/src/bots/systemprompt-cartao-runtime.test.ts` prova o outro lado do gate
  (cartão aparece 1×, SUBSTITUI o override de emojis em vez de somar, gate trava com `baked`) e traz
  **golden byte-a-byte do 1º clone runtime**
  (`__fixtures__/systemprompt-runtime-barbearia.golden.txt`). Regenerar de propósito:
  `UPDATE_GOLDEN=1 npx vitest run <arquivo>`.
- **Import por subpath** (`@startap/integrations/prompt-builder`, não o barrel) no `apps/api`, no
  `portal-api` e no script — evita instanciar o cliente OpenAI só para montar um cartão.
- **Multi-tenancy:** aditivo puro, ancorado em `flow_clones` (que já carrega `slot`/`tenant_id`).
  **Não piora** a dívida P0 de isolamento, mas também não a resolve — o escopo segue por `slot`, sem
  RLS.
- **Comentários corrigidos nesta PR** (eram factualmente falsos após o flip): `teste_barbearia.ts`
  (~685 e ~1499) e `apps/portal-web/src/lib/guia-ativacao.ts:30` diziam
  "`CARTAO_RUNTIME_ENABLED` (OFF em prod)".

## Follow-ups

| # | O quê | Card |
|---|---|---|
| 1 | Fonte ÚNICA do "modo real" (elimina `modo_atendente_enabled` divergente) — **raiz do incidente** | SCRUM-113 |
| 2 | Allowlist fechada também no RENDER (`parseCartaoConfig`) + sanitize de `nome_negocio` | SCRUM-81 |
| 3 | Verificar a 1ª conversa REAL de agendamento nos clones `runtime` (ingrid, dragon) | — |
| 4 | Runbook: rollback do cartão é `--revert` por clone, **não** a flag | — |
