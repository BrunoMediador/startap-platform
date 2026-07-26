# ADR 0034 — Mudança de FORMATO de clone como operação transacional única

- **Status:** **Proposto** — aguardando sign-off do Bruno (apetite + direção da operação única).
- **Data:** 2026-07-24
- **Autor:** 01-arquiteto
- **SCRUM:** SCRUM-137 (raiz — matriz de transições de formato). **Subsume** SCRUM-113 (fonte
  de verdade dupla do modo) e SCRUM-122 (persona não segue o modo). Relaciona SCRUM-138 (guard
  de downgrade estab→individual, PR #498), SCRUM-112 (billing gate).
- **Relacionados:** ADR 0023 (estabelecimento multi-colaborador), ADR 0024 (agenda assistida /
  Service Account por clone), ADR 0027 (billing derivado da agenda), ADR 0030 (gates env→coluna),
  ADR 0031 (sync GCal→atendimentos), ADR 0032 (builder), ADR 0033 (cartão em runtime).
- **Contexto de código:** `startap-platform` @ `main` `b1b779a` (#501). Recon read-only em worktree.

> **Este é um ADR de DESIGN, não registro de entregue.** Nada aqui está implementado. Ele existe
> para o Bruno assinar a DIREÇÃO antes de qualquer código. As transições e os paths citados foram
> conferidos no código; a auditoria adversarial da matriz (SCRUM-137) é o insumo.

---

## Contexto

Um clone tem um **FORMATO** — o par (individual|estabelecimento) × (agenda|atendente). Esse formato
NÃO é uma coluna: ele **emerge de 8 variáveis de estado acopladas**, escritas por caminhos diferentes
(portal, gestão, SQL manual, jobs), **sem nenhuma operação que mude o conjunto de forma coerente**.

### As 8 variáveis que definem o formato (todas conferidas no código)

| # | Variável | Onde mora | Quem escreve |
|---|---|---|---|
| 1 | `personalizacao.agenda_automatica` | `flow_clones.personalizacao` (JSONB) | portal (`portal-perfil.ts:152`), signup (`portal-signup.ts:232`), gestão |
| 2 | `modo_atendente_enabled` | `flow_clones` col. (migr 072) | gestão PATCH, signup, SQL |
| 3 | `product_type` | `flow_clones` col. | gestão PATCH (`server.js:3926`), signup |
| 4 | `seat_cap` | `flow_clones` col. | gestão PATCH (`server.js:3930`) |
| 5 | `cartao_mode` + `cartao_config` | `flow_clones` cols. (migr 075, ADR 0033) | portal cartão-config, flip, script |
| 6 | `prompt_custom` + `bot_prompt.prompt` | `flow_clones` col. + tabela `bot_prompt` | gestão, builder (`prompt-builder.ts`), re-render |
| 7 | `billing_from_agenda_enabled` | `flow_clones` col. (ADR 0027) | gestão, signup |
| 8 | agenda GCal | individual: `flow_clones.gcal_*`; estab: 1 `calendarId`/colaborador em `clone_colaboradores` | gestão (conectar SA), script |

O runtime (`teste_barbearia.ts:537-544`) NÃO lê "o formato". Ele **deriva o modo real** a cada turno:

```
reallyAtendente = resolveModoAtendenteEnabledForSlot(slot)   // #2, env∪coluna
               && !isAgendaAutomaticaIntent(agenda_automatica) // #1  (packages/core/src/agenda-degrade.ts:27)
```

E o billing (`gcal-atend-sync`, `flow-clones.ts:listAtendSyncSlots`) deriva a ação por OUTRA
variável ainda (#7), sem olhar #1 nem #2. E a persona (#6) é escrita por DOIS caminhos com
comportamentos OPOSTOS:

- `regerarPromptClone` (`clone-provisioning.ts:493-535`) **É modo-aware**: escolhe
  `ATENDENTE_PROMPT_TPL` quando `modo_atendente_enabled=true`, senão o template de AGENDA da matriz.
- `updateClone` (`flow-clones.ts:489-517`, chamado pelo portal ao salvar perfil) **NÃO é**: sempre
  aplica `applyPersonalizacao` sobre o template de AGENDA da matriz, ignorando o modo. **Esta é a
  raiz do SCRUM-122.**

### O sintoma: matriz de 8 transições, ZERO limpa

A auditoria adversarial (SCRUM-137, 1 agente por par origem→destino + cético) provou: das 8
transições de formato, **3 quebram cliente e 5 funcionam parcial — nenhuma funciona limpa**. Todas
exibem uma combinação dos mesmos 4 defeitos: (a) meia-transição silenciosa (muda 1 das 8, as outras
7 ficam pra trás); (b) job/cron não reconciliado junto (o sync soft-deleta faturamento quando a
fonte muda); (c) persona/prompt não acompanha o modo; (d) tela que passa a mentir por omissão em vez
de dar erro.

| Transição | Estado hoje | Defeito dominante |
|---|---|---|
| **T2 agenda→atendente** | 🔴 quebra | desligar #1 não desarma #7 → `gcal-atend-sync` pode soft-deletar FATURADO; persona baked segue com cartão + "tá na agenda" (b+c) |
| **T3 individual→estabelecimento** | 🔴 quebra | 1 clique no gestão, sem aviso; com 0 colaboradores (#8) o bot para de agendar e o portal tranca (409 SCRUM-74) (a+d) |
| **T4 estabelecimento→individual** | 🔴 quebra | reconfigurar o calendário apaga FATURADO+comissão realizados; silencioso (b). **Guard parcial** em PR #498 (`bloqueiaDowngradeEstab`) — cobertura abaixo |
| **T1 atendente→agenda** | 🟡 parcial | validar agenda liga #1 (`server.js:4587`, caso MVS) mas **não toca persona** (#6) → SCRUM-122 |
| **T5** individual↔ (persona) | 🟡 parcial | persona não segue o modo (#6) |
| **T6** estab agenda: seat/colab | 🟡 parcial | placeholders de colaborador genérico expostos (#8) |
| **T7** janela transitória | 🟡 parcial | "confirmado" com nada na agenda (#1 sem #8) |
| **T8** cartão no modo errado | 🟡 parcial | verbatim do cartão servido no modo que não tem cartão (#5 vs modo real) |

### O que JÁ existe de guard (para não reinventar)

- **T4 — `bloqueiaDowngradeEstab` (`server.js:3784`, PR #498, SCRUM-138).** BLOQUEIA (409) trocar
  `product_type` para `individual` num clone hoje `estabelecimento` quando há `clone_colaboradores`>0
  **OU** `atendimentos origem='agenda'` realizados (`deleted_at IS NULL AND (fim_at IS NULL OR
  fim_at <= now())`). **Cobre:** o caso destrutivo mais comum, no endpoint de gestão. **NÃO cobre:**
  (i) só roda nesse PATCH — SQL manual e reconfiguração de calendário não passam por ali; (ii) conta
  só faturamento REALIZADO (futuros `fim_at > now` não entram — mitigado porque `colaboradores>0`
  pega estabelecimento real); (iii) apenas BLOQUEIA — não oferece caminho supervisionado, não
  reconcilia #7, não desarma o sync. É stopgap correto, não a solução.
- **T1 — "validar agenda LIGA agenda" (`server.js:4587`, caso MVS).** Conectar+validar a SA flipa
  `agenda_automatica` on. **Cobre** o modo; **explicitamente NÃO toca** `bot_prompt`/persona (#6,
  comentário item 4) nem #7 — meia-transição por design. SCRUM-122 fica.

### A raiz arquitetural (por que remendar transição a transição não fecha)

O formato é um **agregado de 8 variáveis sem fronteira transacional**. Cada nova feature que "edita
tipo depois" escolhe UM subconjunto das 8 pra mexer e deixa o resto pra trás. Corrigir a transição
que quebrou (foi assim com SCRUM-113: o builder foi corrigido, a raiz ficou viva, o mesmo clone
mordeu 2× — 17/07 e 23/07) só empurra o próximo incidente pro próximo consumidor. **A defesa é uma
operação única que trate as 8 como um agregado com invariante de coerência.**

---

## Decisão

### D1 — Formato vira um TIPO fechado derivado, com invariante de coerência explícita

Definem-se **4 formatos válidos** e, para cada um, os valores coerentes das 8 variáveis. Esta tabela
é a **especificação executável** (vira teste de propriedade `assertFormatoCoerente(clone)`):

| Variável | individual-agenda | individual-atendente | estab-agenda | estab-atendente |
|---|---|---|---|---|
| 1 `agenda_automatica` | `true`/ausente | `false` | `true`/ausente | `false` |
| 2 `modo_atendente_enabled` | `false` | `true` | `false` | `true` |
| 3 `product_type` | individual | individual | estabelecimento | estabelecimento |
| 4 `seat_cap` | NULL | NULL | 1..100 | 1..100 |
| 5 `cartao_mode` | baked\|runtime **com SIM** | irrelevante (sem cartão) | runtime var. estab | irrelevante |
| 6 persona (`bot_prompt`) | **agenda** (cartão+SIM) | **atendente** (pré-venda) | **agenda** estab | **atendente** |
| 7 `billing_from_agenda_enabled` | `true` | `false` | `true` | `false` |
| 8 agenda GCal | 1 SA ativa | nenhuma | ≥1 `calendarId`/colab | nenhuma |

**Combinações INCOERENTES (as que quebram hoje) — passam a ser rejeitáveis por código:**

1. `agenda_automatica=true` **∧** `billing_from_agenda_enabled=false` → bot marca, billing não
   espelha (subfaturamento silencioso).
2. `agenda_automatica=false` (atendente) **∧** `billing_from_agenda_enabled=true` → **sync armado
   contra calendário que o dono não gerencia** → soft-delete de faturamento (T2, o pior).
3. modo real = atendente **∧** persona = agenda → bot promete marcar e não tem tool (SCRUM-122; caso
   MVS: 126 mensagens, 0 agendamentos).
4. `product_type=estabelecimento` **∧** `clone_colaboradores`=0 → bot não agenda, portal tranca 409
   (T3).
5. modo real = agenda **∧** agenda GCal ausente/inativa → "confirmado" sem nada na agenda (T7); hoje
   mitigado por `isAwaitingAgendaConnection`/degrade (`agenda-degrade.ts`), mas não é invariante.
6. `cartao_mode=runtime` num modo sem cartão (atendente) → verbatim servido no modo errado (T8).

A invariante NÃO precisa de migration nova para existir como CÓDIGO — é uma função pura sobre as
colunas que já existem.

### D2 — A operação transacional única: `POST /api/clones/:id/formato`

Uma **única** operação, no gestão, que muda o formato como um todo, numa **transação de banco só**.
O portal ganha o caminho equivalente (`POST /portal/formato`, escopado ao slot da sessão — anti-IDOR,
regra de ouro 5), com o subconjunto de transições que são self-service (ver D5).

**Request:**

```
POST /api/clones/:id/formato
{
  "formato_alvo": "individual-agenda" | "individual-atendente"
                | "estabelecimento-agenda" | "estabelecimento-atendente",
  "seat_cap": 1..100 | null,          // obrigatório se alvo estabelecimento-*
  "persona": "regerar" | "manter",    // "manter" só passa se coerente com o modo-alvo (ver §c)
  "confirmar_destrutivo": false        // exigido true quando o preview marca perdas
}
```

**Fluxo (tudo dentro de UMA transação; ordem importa):**

```
0. Carrega o clone (FOR UPDATE) + deriva formato_atual (D1).
   Se formato_atual == formato_alvo E já coerente → 200 no-op (idempotente).

1. PREVIEW (fail-closed): computa o DIFF das 8 variáveis + efeitos colaterais
   destrutivos (faturamento que seria soft-deletado, comissão reescrita, colaboradores
   órfãos, persona que seria descartada). Se houver destrutivo e confirmar_destrutivo!=true
   → 409 { needs_confirm, o_que_muda:[...] }. NADA foi escrito.

2. (a) AJUSTA as 8 variáveis para os valores coerentes do formato_alvo (D1) —
       UPDATE flow_clones (#1..#5,#7) numa statement.

3. (b) RECONCILIA agenda/colaboradores/billing:
       - alvo atendente:  billing_from_agenda_enabled=false (desarma #7 ANTES do sync ver);
                          NÃO apaga clone_colaboradores nem atendimentos (preserva histórico).
       - alvo agenda s/ GCal: entra em "aguardando conexão da agenda" (ADR 0030 D3);
                          runtime degrada via isAgendaAutomaticaIntent && gcal_configured.
       - alvo estabelecimento: exige seat_cap; se 0 colaboradores, provisiona os genéricos
                          (onboarding mastigado) OU marca aguardando-setup, NUNCA deixa
                          incoerência #4 viva.

4. (c) PERSONA — regenera OU BARRA (fail-closed):
       - persona="regerar": chama o seletor modo-aware ÚNICO (D3) → agenda|atendente.
       - persona="manter": só passa se assertPersonaCoerenteComModo(persona_atual, modo_alvo).
         Se o modo-alvo é AGENDA e a persona não tem a mecânica cartão+SIM → 422
         persona_incoerente (NUNCA vira agenda sem cartão+SIM — invariante do ADR 0033).
       - prompt_custom=true + regerar: exige confirmar_destrutivo (descarta persona à mão),
         com snapshot em bot_prompt_versions.

5. (d) SYNC: já desarmado no passo 3 quando alvo=atendente. Quando alvo=agenda, arma #7
       DEPOIS de garantir #8 (ou o estado aguardando). O sync nunca vê um estado intermediário
       (tudo na mesma transação; ele só roda no cron seguinte, sobre o estado já commitado).

6. (e) SNAPSHOT reversível: grava o estado ANTERIOR das 8 variáveis + o bot_prompt anterior
       em uma linha de auditoria (formato_change_log) + bot_prompt_versions. Reverter =
       repostar o formato anterior (mesma operação) OU um endpoint --revert que restaura o snapshot.

7. (f) COMMIT. Resposta devolve O QUE MUDOU (nunca silencioso):
       200 { de: formato_atual, para: formato_alvo, mudou:[{var, antes, depois}...],
             reconciliado:{billing, sync, colaboradores}, persona:"regenerada|mantida",
             snapshot_id }.
```

**Pontos de falha e rollback:** a transação é atômica — qualquer erro entre 2 e 6 dá `ROLLBACK`
total, clone intocado (não há meia-transição possível, que é exatamente a classe de bug que se está
matando). O único efeito fora da transação é a sessão WAHA (não se toca aqui) e o cron do sync (que
só lê o estado JÁ commitado). Rollback pós-commit = `--revert <snapshot_id>`.

### D3 — Fonte ÚNICA do "modo real" (subsume SCRUM-113)

Hoje a fórmula `modoAtendenteFlag && !isAgendaAutomaticaIntent(agenda_automatica)` é **re-derivada**
por, no mínimo, 4 consumidores: runtime (`teste_barbearia.ts:537`), builder
(`prompt-builder.ts:139`), e 2 telas do portal
(`cartao-config-section.tsx:67`, `monte-assistente-section.tsx:95`). O helper de intenção
(`isAgendaAutomaticaIntent`) já é compartilhado; a **combinação** não é. Cada consumidor novo escolhe
sua versão e diverge — foi assim que o clone da Ingrid mordeu 2× (SCRUM-87, incidente do cartão).

**Decisão:** extrair `resolveModoReal(clone) -> 'agenda' | 'atendente'` em `packages/core`
(mesma casa de `agenda-degrade.ts`), com assinatura pura, e fazer **todos** os consumidores —
runtime, builder, telas (via um campo derivado no GET do portal), `updateClone`, o `gcal-atend-sync`
— chamarem essa função. A coluna `modo_atendente_enabled` deixa de ser lida direto por qualquer
consumidor: vira **input** de `resolveModoReal`, nunca a resposta. Blindagem contra re-fork (lição
23/07): teste de consistência que roda a mesma entrada por todos os call-sites e exige resultado
idêntico. A operação D2 é a única escritora que garante `agenda_automatica` e `modo_atendente_enabled`
coerentes entre si, então `resolveModoReal` deixa de precisar reconciliar dois valores que brigam.

### D4 — Persona sempre segue o modo (subsume SCRUM-122)

`updateClone` (`flow-clones.ts:489`) re-renderiza SEMPRE do template de AGENDA da matriz, ignorando o
modo — enquanto `regerarPromptClone` (`clone-provisioning.ts:499`) já escolhe o template certo. A
correção é **colapsar os dois caminhos de re-render numa fonte única modo-aware**: `updateClone`
passa a delegar a regeneração de prompt ao mesmo seletor de `regerarPromptClone`
(`resolveModoReal` → `ATENDENTE_PROMPT_TPL` | matriz de agenda). Assim, salvar o perfil pelo portal
com o toggle de agenda desligado deixa de assar persona de agenda num clone atendente. Dentro da
operação D2, o passo (c) é exatamente esse seletor — a persona nunca fica pra trás numa mudança de
formato.

### D5 — O que é self-service (portal) vs supervisionado (gestão/comercial)

- **Portal (dono, `POST /portal/formato`):** apenas transições que NÃO exigem etapa comercial nem
  conexão de SA e NÃO são destrutivas — na prática, **agenda→atendente** (desligar agenda; hoje já é
  quase self-service via `portal-perfil`, mas incompleto) com toda a reconciliação junta. Ligar
  agenda (atendente→agenda) segue **barrado** (409 SCRUM-74) porque é comercial + SA — a operação
  única não afrouxa isso, apenas o torna coerente.
- **Gestão (operador, `POST /api/clones/:id/formato`):** todas as 4×3 transições, com preview
  destrutivo. É aqui que mora T3/T4 (upgrade/downgrade de estabelecimento) e a religação de agenda
  pós-comercial.

---

## Como o 0034 subsume os cards-sintoma

| Card | Sintoma | Como o 0034 resolve |
|---|---|---|
| **SCRUM-113** | 2 fontes de verdade pro "é atendente?" (`modo_atendente_enabled` vs `flag && !agenda`) | D3: `resolveModoReal` única; todos os consumidores passam a ler ela; coluna vira input, não resposta |
| **SCRUM-122** | persona não segue o modo (`updateClone` re-render só de agenda) | D4: colapsa `updateClone` no seletor modo-aware de `regerarPromptClone`; passo (c) da D2 |
| **SCRUM-137** | mudar formato não é transacional (8 vars, 4 caminhos) | D2: operação única atômica que ajusta as 8 + reconcilia + reporta |
| **SCRUM-138** | guard de downgrade só bloqueia (T4) | D2 substitui o BLOQUEIO por MIGRAÇÃO supervisionada com preview; o guard vira o fallback pra quem não usar a operação |

---

## Plano de subcards priorizado — shippável AGORA vs espera o refactor

Regra: guards fail-closed baratos e avisos "isso vai mudar X" **NÃO esperam** a operação única. Eles
tapam a hemorragia (nada quebra silencioso) enquanto o D2 é construído. Por transição:

| Transição | Guard de curto prazo (shippa AGORA, sem D2) | Resolvido de vez pelo 0034 |
|---|---|---|
| **T2 agenda→atendente** | ao desligar `agenda_automatica`, na MESMA escrita: setar `billing_from_agenda_enabled=false` (desarma o sync) + avisar "seu faturamento pela agenda será pausado". Barato, fail-closed. | passo (b)+(d) da D2 reconcilia billing/sync e persona juntos |
| **T3 individual→estabelecimento** | 409 `upgrade_estab_sem_colaboradores` se `product_type→estabelecimento` com 0 `clone_colaboradores` (espelho invertido do `bloqueiaDowngradeEstab`); OU auto-provisiona genéricos. | passo (b): provisiona/valida seat_cap+colaboradores atômico |
| **T4 estab→individual** | **já existe** (`bloqueiaDowngradeEstab`/#498) — só falta cobrir os outros caminhos de escrita (SQL/reconfig calendário) e trocar a mensagem por "use a migração supervisionada" | D2 vira o caminho supervisionado; guard vira fallback |
| **T1 atendente→agenda** | após `server.js:4587` ligar agenda, DISPARAR regeneração de persona modo-aware (D4 isolado) — mata SCRUM-122 no caso MVS sem D2 completo | passo (c) da D2 |
| **T5 persona×modo** | **D4 isolado** (`updateClone` → seletor modo-aware). É o subcard de MAIOR alavancagem e menor risco; ship primeiro. | idem, absorvido pela D2 |
| **SCRUM-113 (T\*)** | **D3 isolado** (`resolveModoReal` única) — refactor de consolidação, ~1 função + N call-sites; blindado por teste de consistência | pré-requisito lido pela D2 |
| **T6 colab genérico** | copy no gestão "renomeie os colaboradores" (onboarding mastigado já documentado) | passo (b) |
| **T7 janela transitória** | já mitigado por `isAwaitingAgendaConnection`/degrade — só falta virar invariante testada | invariante D1 |
| **T8 cartão modo errado** | `resolveModoReal` (D3) faz o cartão runtime respeitar o modo real (atendente → '') | D1 invariante #6 |

**Ordem recomendada de ship (menor risco → maior):** (1) **D3** `resolveModoReal` única [SCRUM-113];
(2) **D4** `updateClone` modo-aware [SCRUM-122/T5/T1]; (3) guards baratos T2 e T3; (4) só então a
operação transacional **D2** completa, que reusa 1–3 como blocos. 1 e 2 já entregam valor real
(matam 2 incidentes recorrentes) **sem** o refactor grande.

---

## Riscos, migração e apetite

- **Migração de schema:** D2/D3/D4 **não exigem** migration nova — todas as 8 variáveis já são
  colunas/JSONB existentes. Opcional: `formato_change_log` (tabela de auditoria append-only, aditiva)
  para o snapshot da D2; enquanto não existir, `bot_prompt_versions` já cobre a persona e um log
  estruturado cobre o resto. **Zero DDL bloqueante.**
- **Irreversível:** nada aqui é irreversível. A operação D2 é atômica + snapshot; D3/D4 são refactor
  de consolidação com golden/consistência. O único risco de perda é o **já existente hoje** (o
  soft-delete do sync) — que a D2 elimina, não introduz.
- **Risco de regressão (o real):** D3 e D4 tocam o **hot path do runtime** (montagem de prompt) e o
  caminho de save do portal. Byte-identidade de Cirilo/Samuel (golden do ADR 0033) é a rede. Todo
  clone vivo deve sair de `resolveModoReal` com o MESMO modo que sai hoje (teste de equivalência
  antes/depois por clone). Sem isso, não mergeia.
- **Não piora a dívida P0 de isolamento:** aditivo, ancorado em `flow_clones`/slot da sessão. O
  `POST /portal/formato` escopa por `withTenant` (slot nunca do body). Não resolve RLS (P2).
- **Apetite estimado:**
  - D3 (`resolveModoReal` única): **P** — 1 função + ~5 call-sites + teste de consistência. ~1 PR.
  - D4 (`updateClone` modo-aware): **P** — delega ao seletor existente + golden. ~1 PR.
  - Guards baratos T2/T3: **P** — 1 escrita a mais + 1 aviso cada. ~2 PRs pequenas.
  - D2 (operação transacional completa + preview destrutivo + snapshot + endpoints gestão/portal):
    **M-G** — é o refactor de fôlego; **ADR obrigatório antes** (este). ~3–5 PRs em sequência.

---

## Alternativas consideradas

1. **Remendar transição a transição (status quo — guards por par).** Rejeitado como destino: cada
   guard tapa 1 das 8 e o próximo consumidor reabre a raiz (provado 2× no mesmo clone, SCRUM-113).
   **Aceito como PONTE:** os guards baratos (T2/T3) shippam ANTES da D2 pra estancar sangramento.
2. **Coluna `formato` materializada (single enum) como fonte de verdade.** Rejeitada: cria uma
   9ª variável que pode divergir das 8 subjacentes; o formato é derivado, não armazenado.
   `resolveFormato(clone)` puro > coluna que precisa ser mantida em sync.
3. **Máquina de estados formal (lib de FSM) sobre o clone.** Rejeitada por over-engineering: são 4
   estados e ~poucas transições; uma função de coerência + 1 operação transacional resolvem sem
   dependência nova. Boring tech vence.
4. **Resolver só SCRUM-113+122 e deixar a transacionalidade pra depois.** Parcialmente adotada — é
   exatamente a ordem de ship (D3/D4 primeiro). Mas SEM a D2 as transições T2/T3/T4 seguem
   meia-transição; por isso D2 fica no plano, não fora.
5. **Force-migrar todos os clones vivos pro estado coerente num backfill.** Rejeitada: alguns clones
   têm incoerências intencionais/históricas (Ingrid: flag atendente + roda agenda). Coerência é
   imposta na PRÓXIMA mudança de formato (via D2) e verificada por invariante, não por big-bang.

---

## Critérios de aceitação (verificáveis)

- **D1:** `assertFormatoCoerente(clone)` existe como função pura; roda em todo clone vivo e reporta
  as incoerências conhecidas (Ingrid) sem lançar. As 6 combinações incoerentes têm teste dedicado.
- **D2:** `POST /api/clones/:id/formato` muda as 8 variáveis numa transação; falha injetada em
  qualquer passo → clone byte-idêntico ao anterior (prova de atomicidade). Preview destrutivo
  retorna 409 sem escrever. Resposta lista `mudou[]` não-vazio para toda transição real.
- **D3:** grep prova que NENHUM consumidor lê `modo_atendente_enabled` direto para decidir modo —
  todos passam por `resolveModoReal`. Teste de consistência: mesma entrada → mesmo modo em todos os
  call-sites. Todo clone vivo mantém o modo atual (equivalência antes/depois).
- **D4:** salvar perfil com `agenda_automatica=false` num clone `prompt_custom=false` gera persona de
  ATENDENTE (não de agenda). Golden byte-a-byte de Cirilo/Samuel inalterado.
- **Guards curto-prazo:** T2 desliga `billing_from_agenda_enabled` junto (sync não soft-deleta mais);
  T3 barra/provisiona (nunca estabelecimento com 0 colaboradores vivo).
- Suíte raiz `npx vitest run` verde; smoke e2e humano-no-navegador por formato (lição 27/06).

---

## Follow-ups

| # | O quê | Card |
|---|---|---|
| 1 | `resolveModoReal` única + consolidar consumidores | SCRUM-113 |
| 2 | `updateClone` modo-aware (colapsar com `regerarPromptClone`) | SCRUM-122 |
| 3 | Guards baratos T2 (desarmar billing junto) e T3 (upgrade sem colaboradores) | novos subcards de SCRUM-137 |
| 4 | Operação transacional `POST /formato` (gestão + portal) + preview + snapshot | novo subcard de SCRUM-137 |
| 5 | `bloqueiaDowngradeEstab`: cobrir os demais caminhos de escrita + apontar pra migração supervisionada | SCRUM-138 |
