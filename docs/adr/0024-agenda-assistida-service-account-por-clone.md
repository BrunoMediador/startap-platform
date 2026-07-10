# ADR 0024 — Agenda assistida: 1 Service Account por clone, N calendarIds por colaborador, com credencial cifrada e rotacionável

- **Status:** ACEITO (em produção; documentado retroativamente — o código cita "ADR 0024" desde a Fase A do estabelecimento e a criptografia de credenciais, 2026-05/06). Drift de documentação corrigido em SCRUM-44.
- **Data:** 2026-07-10 (doc); decisões originais: criptografia AES-256-GCM ~2026-05-19 (Missão 012-A2); agenda multi-colaborador ~2026-06-15 (Fase A ADR 0023/0024).
- **Autor:** 01-arquiteto
- **Aprovado por:** Bruno
- **Relacionados:** ADR 0006 (Google Calendar por clone — **estende**: 0006 fixou 1 SA/clone no caso individual e **adiou** a criptografia at-rest em D1; este ADR generaliza para N calendarIds e **cifra** a credencial), ADR 0018 (`tenant_id` — isolamento), ADR 0023 (modelo de conta estabelecimento — o **quê**; este é o **como** da agenda), ADR 0025 (pacotes — escopo casa/colaborador).

---

## Contexto

O ADR 0006 estabeleceu **1 Service Account (SA) JSON por clone** para o caso **individual** (1 agenda). Dois novos requisitos exigiram estender o modelo:

1. **Estabelecimento (ADR 0023):** um clone tem **vários profissionais**, cada um com sua agenda. Precisamos de **N calendarIds** por clone, mantendo **uma única SA** (uma identidade Google por cliente), com isolamento e sem estourar cota nem custo de chamadas.
2. **Segurança/LGPD:** o `gcal_credentials_json` guarda a `private_key` da SA. O ADR 0006 D1 **adiou conscientemente** a criptografia at-rest; a auditoria 2026-05-19 reclassificou como **P0**. Precisa cifrar **sem** perder retrocompatibilidade com o que já está gravado e **sem** deixar de poder trocar a chave.

Restrições que moldam a decisão:

- **Agenda assistida, não self-service.** O cliente médio (barbeiro, Gmail pessoal) não conecta OAuth sozinho. O **operador** conecta a SA no gestão; o cliente só **compartilha** a agenda dele com o e-mail da SA e informa o `calendarId`. Não há callback público nem consent screen (herdado de ADR 0006 opção C).
- **Isolamento P0.** Clone A nunca pode ler/escrever na agenda de B; colaborador X nunca na de Y.
- **Sem ORM.** Migrations SQL raw; leitura quente com cache em memória.

---

## Decisão

### §1 — Agenda assistida (quem conecta o quê)

- O **operador** sobe o JSON da SA do clone no **gestão** (`painel-admin`), aba Google Calendar. O painel extrai o `client_email`, testa a conexão e só então marca `gcal_status='active'` (fim do "active mentiroso").
- O **cliente** compartilha a agenda dele (individual) ou de cada barbeiro (estabelecimento) com o `client_email` da SA, permissão "Fazer alterações nos eventos", e informa o `calendarId`.
- O **portal do cliente NÃO conecta a SA** — só edita metadados. A credencial de login Google entregue no portal (`portal-google-conta.ts:6`, migration 061) é **outra coisa**: um login humano da conta Google que a empresa criou pro cliente, escopo **distinto** da SA do bot.

### §2 — 1 Service Account por clone, N calendarIds por colaborador

A credencial (`gcal_credentials_json`) é **do CLONE** (`flow_clones`), **uma SA por cliente**. No estabelecimento, **cada colaborador tem seu `calendarId`** (`clone_colaboradores.gcal_calendar_id`), mas **todos usam a mesma SA do clone**. O teste de conexão por colaborador reusa a SA do clone + o `calendarId` do colaborador e é a **única via** que promove o colaborador a `gcal_status='active'` (`server.js:6632`).

Consequência de implementação: como todos os calendários de um clone são da mesma SA, **qualquer client bound àquela SA serve** para consultar qualquer um dos calendarIds do clone (`client.ts:202`, `estabelecimento.ts:257`).

### §3 — Agenda criada sob demanda

`clone_colaboradores.gcal_calendar_id` nasce `NULL` e é preenchido quando o calendarId do colaborador é conectado/criado sob demanda (não no cadastro). Colaborador sem `calendarId`/`gcal_status='active'` **não entra** na montagem de agenda (fica `pending`).

### §4 — Isolamento por `slot` + `tenant_id` (defesa em profundidade + anti-IDOR)

O resolvedor de agendas de colaborador (`getGcalsForSlot`, `per-clone.ts:222`) é o ponto crítico de isolamento:

- a `SELECT` **projeta `tenant_id`** (o caminho individual não projeta) e faz `JOIN clone_colaboradores ON cc.slot = fc.slot AND cc.tenant_id = fc.tenant_id`, escopado por `slot`;
- o **cache** é chaveado por `(slot, colaboradorId)` e cada entry guarda `{ slot, colaboradorId, tenantId, client }`; um hit só é servido se **`(slot, tenantId, colaboradorId)` baterem exatamente** — entry de outro tenant/slot (ou chave colidida) é **MISS**, nunca devolvida;
- o **LLM nunca recebe `calendarId`/e-mail de agenda cru** — só um **id curto** (`C1`, `C2`…); o servidor resolve o `calendarId` a partir do id curto, validando contra a lista ATIVA daquele `slot`/`tenant` (`per-clone.ts:138`, `:157`);
- nas rotas do portal (`portal-agenda-slots.ts:135`, `portal-agendamentos.ts`, `portal-colaborador.ts:85`), `colaborador_id` é **exigido** e validado server-side; colaborador de outro tenant → **404** (anti-IDOR); o `slot` vem SEMPRE da sessão (`withTenant`), nunca de input.

### §5 — Uma chamada `freebusy.query` batched

A ocupação de **todos os colaboradores** de um estabelecimento é lida em **UMA** chamada `freebusy.query` batched com todos os `calendarId` juntos (`client.ts:196`, `estabelecimento.ts:236`) — não uma chamada por barbeiro. Limite duro da API = **50 calendarIds/chamada** (`client.ts:217`); estabelecimentos pequenos nunca chegam lá.

**Fail-safe conservador:** um `calendarId` que o Google não resolveu (sem permissão/erro) **não aparece** no mapa (ou vem com `errors`); o caller trata ausência como "não sei a ocupação" e é **conservador** (não oferece o horário) — nunca inventa disponibilidade (`client.ts:44`). Se o `freebusy` falha inteiro (401/403), invalida o cache e o bot **silencia** — não cai pro caminho individual (vazaria a agenda principal do clone).

### §6 — Blocos de runtime não-editáveis (só no estabelecimento)

No caminho estabelecimento, o bot injeta **EM RUNTIME** (não no template estático do `bot_prompt`) blocos rotulados por colaborador: `[PROFISSIONAIS]`, `[HORARIOS]` por colaborador, cartão de confirmação com a linha do profissional, regra de desambiguação de homônimos (`teste_barbearia.ts:1422`). Injetar em runtime (e não no prompt editável) garante que **todo** clone estabelecimento — inclusive os já existentes — receba a regra sem re-renderizar o prompt, e que o cliente não a edite/quebre. O clone individual nunca vê esses blocos.

### §AC5 — Credencial cifrada AES-256-GCM com rotação de chave

`gcal_credentials_json` é cifrado com **AES-256-GCM** (`packages/core/src/crypto.ts`). Formato armazenado: `enc:<ver>:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>`.

- **`enc:v2`** — cifrado com `GCAL_ENCRYPTION_KEY` (chave atual); é o que `encryptSecret` grava hoje (`CURRENT_PREFIX`).
- **`enc:v1`** — chave legada; decifra com `GCAL_ENCRYPTION_KEY_OLD` se definida, senão com `GCAL_ENCRYPTION_KEY`.
- **sem prefixo `enc:`** — dado legado em texto claro (fallback de migração gradual).

**Rotação de chave sem perder credencial** (runbook `docs/runbooks/rotacao-gcal-encryption-key.md`): (1) provisiona `K_new` como `GCAL_ENCRYPTION_KEY` e `K_old` como `GCAL_ENCRYPTION_KEY_OLD`; (2) deploy — passa a gravar `enc:v2` e ainda lê `enc:v1` (janela de coexistência); (3) `scripts/rotate-gcal-key.ts` re-cifra `v1→v2`; (4) remove `GCAL_ENCRYPTION_KEY_OLD` após validar zero `enc:v1`.

**Retrocompat inegociável:** no estado de hoje (tudo `enc:v1`, só `GCAL_ENCRYPTION_KEY`, sem `OLD`), toda credencial existente continua decifrando com `GCAL_ENCRYPTION_KEY` — comportamento idêntico ao anterior. `GCAL_ENCRYPTION_KEY` é **obrigatória no boot** (ausência lança erro imediato, não silencioso). A **rotação da chave é pré-requisito operacional do 1º estabelecimento REAL** (`config.schema.ts:239`), não da flag de código.

### §7 — Health-check da agenda

Um cron (`GCAL_HEALTHCHECK_ENABLED`, `gcal-healthcheck.ts`) revalida cada agenda `active` periodicamente e corrige `gcal_status`. No estabelecimento, lê os `calendarIds` de `clone_colaboradores` com a credencial do CLONE (§2). Risco residual conhecido: o Google retorna `403` tanto para "forbidden" quanto para rate-limit — o cron trata `403` como definitivo e pode rebaixar agenda boa num pico (dívida registrada, SCRUM-41).

---

## Alternativas consideradas

1. **Uma SA por colaborador (N SAs por clone).** Rejeitado: multiplica a operação (criar/compartilhar N SAs), N identidades para o cliente gerenciar, e não traz isolamento extra — o isolamento já é `slot`+`tenant_id`+`calendarId`. Uma SA/clone com N calendarIds é mais simples e barata.
2. **Uma chamada `freebusy` por colaborador.** Rejeitado: N chamadas por turno de chat = latência + cota. `freebusy.query` batched resolve todos em 1 request (§5).
3. **Passar `calendarId`/e-mail da agenda ao LLM.** Rejeitado (vazamento + IDOR): o LLM só vê id curto (`C1`…); o servidor resolve e valida contra a lista do slot/tenant (§4).
4. **Não cifrar a credencial (manter D1 de ADR 0006).** Rejeitado após a auditoria 2026-05-19 (P0): `private_key` em claro no Postgres + backup. AES-256-GCM com rotação resolve sem perder retrocompat.
5. **Substituir a chave direto (sem versionamento `enc:v1/v2`).** Rejeitado: trocar a chave perderia toda credencial já gravada. O versionamento por prefixo + `GCAL_ENCRYPTION_KEY_OLD` dá janela de coexistência e rotação sem downtime.
6. **Self-service: cliente conecta a agenda pelo portal.** Rejeitado como padrão: público-alvo (Gmail pessoal, baixa maturidade) erra o passo; agenda assistida pelo operador tem menos suporte e menos superfície pública. O portal só edita metadados.
7. **Fallback do clone sem agenda própria para a agenda da matriz.** Rejeitado (vazamento cross-tenant): clone sem GCal próprio **silencia**, nunca usa a agenda da matriz (`per-clone.ts:8-11`).

---

## Consequências

**Positivas:**

- Agenda multi-colaborador com isolamento forte (`slot`+`tenant_id`+`calendarId`, cache MISS cross-tenant, LLM cego ao `calendarId`) e custo de API contido (1 `freebusy` batched).
- Credencial cifrada at-rest (fecha o P0 de ADR 0006 D1) e **rotacionável** sem downtime nem perda.
- Blocos de runtime garantem que regras de estabelecimento cheguem a todo clone (inclusive os já existentes) sem editar prompt.
- Agenda assistida: sem callback público, sem consent screen, compatível com Gmail pessoal.

**Negativas / dívida aceita:**

- **Operação manual** por cliente: o operador cria a SA, sobe o JSON, e (estabelecimento) cadastra N `calendarIds` e testa cada um. Onboarding "mastigado" ([[onboarding-estabelecimento-mastigado]]).
- Cota da SA (10k req/dia default) é compartilhada por todos os calendarIds do clone — monitorar.
- Health-check trata `403` como definitivo → pode rebaixar agenda boa em rate-limit (SCRUM-41).
- App conecta como superuser do PG e RLS segue adiada ([[db-app-superuser-rls-adiada]]); o isolamento hoje depende do chokepoint `withTenant`/`requireTenant` + do escopo explícito por `slot`/`tenant_id` nas queries. `tenant_id` já projetado prepara a RLS.

---

## Critérios de aceitação (verificáveis)

1. **Isolamento (§4):** entry de cache de outro tenant/slot é MISS (`per-clone.test.ts`); rota de portal com `colaborador_id` de outro tenant → 404; sem `colaborador_id` → 422; `slot` sempre da sessão.
2. **Batching (§5):** montar a agenda de um estabelecimento com K colaboradores faz **1** `freebusy.query` com os K calendarIds (`estabelecimento.test.ts`); K>50 é rejeitado no client.
3. **Fail-safe (§5):** calendarId sem permissão → tratado como ocupação desconhecida (conservador); `freebusy` 401/403 → invalida cache + bot silencia, nunca usa a agenda do clone.
4. **Cripto/rotação (§AC5):** `encryptSecret` grava `enc:v2`; `decryptSecret` lê `enc:v1` (com `OLD` ou sem), `enc:v2` e texto claro legado (`crypto.test.ts`); `GCAL_ENCRYPTION_KEY` ausente = erro no boot; retrocompat: `enc:v1` sem `OLD` decifra com `GCAL_ENCRYPTION_KEY`.
5. **Promoção a `active` (§2):** um colaborador só vira `gcal_status='active'` após teste real da SA do clone + `calendarId` dele (sem "active mentiroso").
6. **Individual intocado:** com `ESTABELECIMENTO_ENABLED` OFF, o caminho individual (`getGcalForSlot`) é byte-a-byte o de hoje.

---

## Referências de código (embasamento)

- `packages/core/src/crypto.ts:13`, `:37` (rotação `enc:v1/v2`, `CURRENT_PREFIX`, AC5) + `packages/core/src/crypto.test.ts:92`
- `packages/integrations/src/google-calendar/per-clone.ts:23`, `:138`, `:157`, `:178`, `:208`, `:215`, `:217`, `:233`, `:286` (isolamento §4, 1 SA §2, sob demanda §3)
- `packages/integrations/src/google-calendar/client.ts:44`, `:196`, `:202`, `:217` (freebusy batched §5, até 50 calendarIds)
- `packages/integrations/src/scheduling/estabelecimento.ts:2`, `:15`, `:236`, `:257` (montagem multi-colaborador, batched §5) + `estabelecimento.test.ts:2`, `:82`
- `packages/integrations/src/google-calendar/per-clone.test.ts:10`, `:209` (isolamento §4 sob teste)
- `apps/api/src/bots/teste_barbearia.ts:1305`, `:1310`, `:1312`, `:1422` (agenda por colaborador §4/§5, blocos runtime §6) + `teste_barbearia.test.ts:276`
- `apps/portal-api/src/routes/portal-agendamentos.ts:162`, `:524`, `:1058`; `portal-agenda-slots.ts:135`; `portal-colaborador.ts:11`, `:85`; `portal-equipe.ts:8` (anti-IDOR §4, agenda assistida)
- `apps/portal-api/src/routes/portal-google-conta.ts:6` (login Google do cliente = escopo distinto da SA)
- `apps/worker/src/jobs/gcal-healthcheck.ts:16` (health-check §7, credencial do clone §2)
- `packages/db/src/queries/gcal-health.ts:9`, `:34`, `:77`; `flow-clones.ts:815`; `clone-colaboradores.ts:340` (1 SA/clone §2, JOIN escopado §4)
- `packages/db/migrations/053_clone_colaboradores.sql:22`, `:44` (calendarId por colaborador, sob demanda §3); `061_google_account.sql:8`; `066_clone_colaboradores_gcal_last_check.sql:12`
- `apps/api/src/config.schema.ts:239` (rotação da chave = pré-requisito do 1º estabelecimento real)
- `painel-admin/server.js:71` (retrocompat AC5), `:6632` (teste por colaborador, 1 SA §2)
