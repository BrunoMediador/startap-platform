# ADR 0030 — Produtização self-service dos 4 formatos: universalizar features por-clone (env→coluna) e mover a decisão de formato pro signup

- **Status:** Proposto (aguarda feedback do PM/Bruno + review de security)
- **Data:** 2026-07-09
- **Autor:** 01-arquiteto
- **Contexto de código:** repo `startap-platform` @ main ~5199fa4 (#432). Recon read-only em clone local.
- **Relacionados:** ADR 0024 (agenda assistida / Service Account), ADR 0025 (pacotes), ADR 0026 (atendimentos), ADR 0027 (billing-da-agenda por-clone), SCRUM-59 (modo atendente/Meduzza), SCRUM-65 (FAQ personalizado), SCRUM-66 (varredura de produto).
- **Insumo:** `docs/empresa/varredura-produto-2026-07-09.md`.

---

## Contexto

A diretriz do Bruno (09/07) é deixar o **produto self-service completo**: os 4 formatos — individual/estabelecimento × agenda/atendente — precisam ser **contratáveis pelo signup sem env manual**, com a ÚNICA etapa manual aceita sendo o time conectar a agenda Google (SA, ADR 0024) **depois** do signup, quando o formato tiver agenda. Regra dura: **"nunca piorar"** — quem já usa (Cirilo, Samuel, dragon, Meduzza) tem comportamento preservado byte-idêntico até uma migração explícita.

A varredura (SCRUM-66) confirmou: **os 4 formatos existem e funcionam**, mas o funil self-service cobre só 1 (individual-agenda até "bot responde"). Os outros 3 exigem env manual (`recreate`) + wizard no gestão.

### Raiz comum do problema

Levantamento de paridade (bot + portal/gestão) achou **7 lacunas** com uma raiz única: o **modo atendente** (SCRUM-59, piloto Meduzza) nasceu carregando um pacote de features de "atendimento humano no mesmo número" — `escalar_para_humano`, pausa por resposta manual (human_reply), frases de comando editáveis, destino do alerta ao dono (`alert_owner_phone`), planos/assinaturas — que na verdade valem pra **QUALQUER** formato, porque **todo clone é IA + dono-que-responde-à-mão no mesmo WhatsApp**. O acoplamento dessas features a `MODO_ATENDENTE_SLOTS` foi **conveniência de rollout, não requisito de domínio**.

Hoje 3 gates de produtização são **env-CSV por-slot**, todos com helper puro idêntico `(slot, csvEnv) → bool`:
- `MODO_ATENDENTE_SLOTS` — `packages/core/src/modo-atendente-gate.ts`
- `ATEND_FROM_AGENDA_SLOTS` — `packages/core/src/atend-from-agenda-gate.ts`
- `FAQ_PERSONALIZADO_SLOTS` — `packages/core/src/faq-personalizado-gate.ts`

Ao mesmo tempo, `product_type` **já é coluna real** (individual/estabelecimento) e gateia corretamente o que é genuinamente de estabelecimento (equipe/comissão/agenda-por-colaborador). O signup (`apps/portal-api/src/routes/portal-signup.ts:~178-210`) só provisiona `individual`; a escolha de vertical/área é a única do cliente; `product_type` só muda no gestão.

### Duas classes de gap (importa pro sequenciamento e risco)

- **(a) tool/bloco realmente AUSENTE no bot** — `escalar_para_humano` nos formatos de agenda (`buildEscalarParaHumanoTool`, `teste_barbearia.ts:186`, ramos `:618`/`:1415`), `consultar_pacote`+`[SEU PACOTE]` no estabelecimento, human_reply pause (`router.ts:477`, `base.ts:134`). Escopo backend/waha.
- **(b) feature JÁ universal no bot+backend, presa por gate de UI/rota ao modo atendente** — planos (`planos-section.tsx:107`; PUT `portal-perfil` já universal), frases de pausa (`portal-frases-pausa.ts:51`, 404 fora do atendente; bot já honra keyword em todos os ramos, `router.ts:477`), destino de alerta (`portal-perfil.ts:96/:127`; `alert_owner_phone` já usado por todos os kinds). **Classe (b) é a mais barata e de menor risco: o produto já FAZ, só não deixa configurar.**

### Distinção de método (o critério que separa universalizar do que NÃO)

Ao auditar paridade, separar **gate de rollout** (conveniência, deve morrer) de **gate de domínio** (o formato realmente não suporta, deve permanecer). Só o segundo barra universalização. NÃO universalizar (gate de domínio legítimo):
- Tools de agenda (`inserir`/`consultar`/`remarcar_agendamento`), `[HORARIOS]`, billing-da-agenda e dedução de pacote **não vão** pro modo atendente — atendente é deliberadamente sem agenda (requisito nº1 do Meduzza).
- Equipe/colaboradores/comissão/agenda-por-colaborador/`[PROFISSIONAIS]` = só `product_type=estabelecimento`.
- GCal Service Account / aba gcal / link de agendamento = só formatos COM agenda (etapa manual do time, ADR 0024).
- Nome do prestador único (Perfil) = só individual/solo.
- Edição de prompt/persona = só gestão (ajuste do time, não self-service).
- Lembretes = OFF consciente (copy pendente do Bruno + LGPD/opt-in), NÃO é bug.
- `[EQUIPE]` (atendente, nome-only) e `[PROFISSIONAIS]` (estab+agenda, calendar-backed) **não** se fundem — mecânicas distintas.

---

## Decisão

Adota-se **1 ADR guarda-chuva** ("universalizar o produto por-clone") em vez de 1 ADR por mudança estrutural. Justificativa (responde à CONSULTA[@arquiteto]): as 7 lacunas + o seletor de formato no signup + a pausa humana nos formatos de agenda **compartilham uma decisão macro única** — matar os gates env-manual e mover a produtização pra **config por-clone**, com `product_type` + `agenda_automatica` como os dois eixos de domínio decididos no signup. Fragmentar em 2+ ADRs criaria ambiguidade de sequência sobre uma decisão coerente. A pausa humana **não é** decisão arquitetural separada — é aplicação do mesmo princípio ("universalizar feature transversal atrás de opt-in por-clone"); ela apenas carrega risco de runtime maior (hot path do router), então ganha **onda própria + qa e2e obrigatório**, não ADR próprio.

### D1 — Mecanismo de migração env→coluna (o núcleo; garante "nunca piorar" + reversível)

Introduzir uma **camada de resolução por-clone** que computa o booleano efetivo como **UNIÃO**:

```
efetivo(feature, slot) = isEnabledFromCsv(slot, envCsv)  ||  colunaPorClone(slot)
```

- **Env permanece como kill-switch/override global** (slot no CSV ou `*` → ON, ignora coluna). Continua sendo o botão de pânico sem deploy.
- **Nova coluna por-clone** dirige o self-service.
- **Prova de byte-identidade:** os clones ON hoje estão no CSV → a UNIÃO os mantém ON **independente** da coluna. Backfill seta `coluna=true` pra eles. Depois (opcional) remover do CSV os mantém ON via coluna. O cutover env→coluna é **invisível** e reversível em qualquer ponto (coluna=false ou re-adicionar no CSV volta ao estado anterior).

**Armazenamento — decisão:** colunas booleanas tipadas em `flow_clones` (`NOT NULL DEFAULT false`), uma migration adicionando as três (`modo_atendente_enabled`, `faq_personalizado_enabled`, `billing_from_agenda_enabled`). Preferidas sobre JSONB por: validação forte no schema SQL raw (casa não tem ORM), queryáveis/indexáveis, DDL explícito, default seguro trivialmente reversível em comportamento (ninguém lê até a camada de resolução subir; e a resolução faz OR do env, então mesmo lendo não muda nada até backfill). `product_type` e `seat_cap` já são colunas; `agenda_automatica` já vive em `personalizacao` (JSONB) — reusar como estão.

Os 3 helpers puros CSV **permanecem** (testados, sem I/O); a camada de resolução os envolve com o OR da coluna.

### D2 — Signup com seletor de formato (os 4 combos)

Duas perguntas simples no cadastro, mapeando pros eixos de domínio:

| Pergunta (copy = Bruno) | Resposta → mapa | Provisiona |
|---|---|---|
| "Você atende sozinho ou tem uma equipe?" | sozinho → `product_type=individual`; equipe → `estabelecimento` (+ `seat_cap` default) | coluna `product_type`, `seat_cap` |
| "A IA marca sozinha na sua agenda, ou só atende e encaminha?" | agenda → `agenda_automatica=true`; atende → `false` | `personalizacao.agenda_automatica` + flags por-clone |

Mapa dos 4 combos → o que provisiona:
- **solo + agenda** → individual, `agenda_automatica=true`, `billing_from_agenda_enabled=true`. **Precisa conexão GCal SA (etapa manual do time).**
- **solo + atendente** → individual, `agenda_automatica=false`, `modo_atendente_enabled=true`. Sem GCal.
- **equipe + agenda** → estabelecimento, `seat_cap`, `agenda_automatica=true`, `billing_from_agenda_enabled=true`. **Precisa GCal SA + calendarId por colaborador (etapa manual).**
- **equipe + atendente** → estabelecimento, `seat_cap`, `agenda_automatica=false`, `modo_atendente_enabled=true`. `[EQUIPE]` name-only, sem GCal.

O signup grava `product_type`/`seat_cap`/`agenda_automatica` + as flags por-clone (D1). **Preço = placeholder editável** (`PORTAL_SIGNUP_AMOUNT_CENTS` hoje R$99,99); valor real por formato = decisão do Bruno (não bloqueia engenharia). Paridade com o wizard do gestão preservada (mesmo provisioning).

### D3 — Agenda manual como serviço + degrade elegante

Cliente self-service que escolheu **agenda** entra em estado **"aguardando conexão da agenda"**: (a) fila no gestão, (b) aviso interno via ALERTAS, (c) copy no portal (Início + `/agenda`) "nossa equipe está conectando sua agenda do Google (até ___)". Substitui o empty genérico atual (`agenda/page.tsx:51-56`).

**Degrade elegante (recomendado, com guarda-corpo):** enquanto `gcal_configured=false`, o **comportamento efetivo** do bot degrada pra atendente (coleta lead + `escalar_para_humano`/`registrar_interesse` como fallback), **sem** expor tools de agenda nem `[HORARIOS]`, **sem prometer horário**. Implementar como **derivação de runtime** (`efetivo = agenda_automatica && gcal_configured`), NÃO como flip do valor armazenado — a intenção (agenda) fica gravada; ao conectar a SA, o runtime resolve naturalmente pra agenda, sem migração de estado e sem tocar clones já conectados (que nunca entram nesse estado transitório). É seguro e coerente porque o caminho atendente já existe e é format-agnostic. **Decisão de produto (primeira impressão) = Bruno** (pergunta aberta).

### D4 — Escopo de universalização por classe (paridade)

- **Classe (b) — de-gate UI/rota (byte-safe, prioridade):** planos, frases de pausa, destino de alerta (`recepcao_telefone`), FAQ→`*`. Remover `gateModoAtendente`/gate de env da rota/UI; o render do contexto do bot **NÃO** muda (preserva byte-identidade de quem já usa).
- **Classe (a) — tool/bloco novo atrás de flag OFF:** `consultar_pacote`+`[SEU PACOTE]` no estabelecimento (gated `PACOTES_ENABLED`, read-only, sem risco de dobra — dedução já existe e é intocada); `escalar_para_humano` nos ramos de agenda (`:618`/`:1415`) atrás de flag por-clone (OFF = byte-idêntico). **Novo callsite de alerta → requer review de security** (PII).
- **Alto risco (opt-in + ADR + e2e):** human_reply pause (60min) + anti-eco (`registerBotReplyEcho`) nos formatos de agenda. **Muda comportamento de Cirilo/Samuel quando ligado → NUNCA liga direto em pagante**; opt-in por-clone, go explícito do Bruno por clone.

### D5 — Não-alvos (mantidos como estão)

Lembretes (parked — copy + LGPD), antibot `BOT_DETECT_*` (rollout de segurança faseado, ordem do Bruno), edição de persona (só gestão), tools de agenda no atendente, fusão `[EQUIPE]`/`[PROFISSIONAIS]`. Fuso por clone, alerta de desconexão e alerta de cliente-novo **já são universais** — não reabrir.

---

## Consequências

**Positivas:**
- Os 4 formatos ficam contratáveis pelo signup; a única etapa manual = conexão da SA (ADR 0024), com transparência ao cliente.
- Features transversais deixam de ficar reféns do nome de um piloto; produto "pra cima" sem piorar ninguém.
- Env vira kill-switch global (operação mantém o botão de pânico), coluna vira a fonte self-service — reversível byte-a-byte.
- `product_type`/`agenda_automatica` viram os únicos eixos de domínio; menos superfície de env-CSV manual.

**Negativas / dívida aceita:**
- +3 colunas em `flow_clones` + camada de resolução (pequena, testável).
- Signup cresce >300 linhas e passa a tocar caminho que leva à credencial GCal (indireto) → review de security obrigatório.
- Degrade elegante adiciona uma derivação de runtime (`efetivo`) — precisa cobertura de teste pra não vazar tool de agenda quando `gcal_configured=false`.
- App conecta como superuser do PG e RLS segue adiada (dívida P0 conhecida, [[db-app-superuser-rls-adiada]]) — este ADR **não** piora isso, mas toda coluna nova de gate reforça a importância do chokepoint `withTenant`/`requireTenant` (slot sempre da sessão, nunca de input).

**Dependências / consultas (PM faz a ponte):**
- **CONSULTA[@security]:** estender `escalar_para_humano`/human_reply pros formatos de agenda reusa `alert_owner_phone` com **telefone do cliente EM CLARO no corpo do alerta ao dono** (`client-alert.ts:139`). Confirmar que o modelo LGPD atual (clear no WhatsApp ao **controlador** dos dados + hint mascarado no log) é aceitável **fora** do modo atendente. Hoje esse clear-phone só existe em escalonamento/lead, que só existem no atendente. Bloqueia Onda 2 (escalar) e Onda 3 (signup).
- **CONSULTA[@uiux-designer]:** 2 telas — passo de formato no cadastro + card pós-signup "nossa equipe está conectando sua agenda" com status (aguardando/conectada).

---

## Alternativas consideradas

1. **1 ADR por mudança estrutural (human_reply + signup separados).** Rejeitado: fragmenta uma decisão macro única (env→coluna) e cria ambiguidade de sequência. A pausa humana é aplicação do princípio, não decisão nova.
2. **JSONB único `feature_flags` em vez de colunas tipadas.** Rejeitado como padrão: perde validação forte do schema SQL raw (casa sem ORM), menos queryável. Colunas tipadas `NOT NULL DEFAULT false` são mais "boring/reversível". (JSONB `personalizacao` segue para `agenda_automatica`, que já mora lá.)
3. **Substituir env por coluna (sem UNIÃO/kill-switch).** Rejeitado: perde o botão de pânico global sem deploy e torna o cutover arriscado. A UNIÃO env||coluna garante byte-identidade e rollback trivial.
4. **Flip de estado do `agenda_automatica` no degrade (agenda→atendente enquanto SA pendente).** Rejeitado a favor de derivação de runtime (`efetivo = agenda_automatica && gcal_configured`): evita migração de estado, evita risco de flip retroativo, e não toca clones já conectados.
5. **Universalizar tudo de uma vez (big bang).** Rejeitado: viola "cada onda = PRs pequenas mergeáveis em sequência" e mistura risco baixo (de-gate UI) com alto (hot path router). Faseado por risco.
6. **Manter runbook manual dos combos 2/3/4 (sem produtizar).** Rejeitado como destino final (contraria a diretriz), mas **aceito como ponte** enquanto as ondas rodam — vender os 4 formatos já, com onboarding manual ~15min.

---

## Critérios de aceitação (verificáveis)

- **Byte-identidade (invariante central):** pra cada clone vivo (Cirilo, Samuel, dragon, Meduzza), `efetivo(feature)` **==** `env_only(feature)` antes e depois do backfill, para as 3 features migradas. Suíte raiz `npx vitest run` segue **2161/0** (verde da main).
- **D1:** migration adiciona as 3 colunas `NOT NULL DEFAULT false`; migration reversível; backfill espelha o CSV atual (dragon/cirilo/samuel/meduzza). `schema_migrations` incrementa +1.
- **D2:** signup com resposta "solo+agenda" produz clone byte-idêntico ao que o signup produz hoje (regressão zero no caminho existente); os outros 3 combos provisionam `product_type`/`seat_cap`/`agenda_automatica`/flags corretos, verificáveis por SELECT.
- **D3 degrade:** clone agenda com `gcal_configured=false` **nunca** expõe tool de agenda nem `[HORARIOS]` (teste unit no resolvedor de `efetivo`); ao setar `gcal_configured=true`, resolve pra agenda sem novo deploy.
- **Classe (b):** de-gate não altera o render do contexto do bot (snapshot/golden test do bloco de contexto inalterado para Cirilo/Samuel).
- **Onda 4:** human_reply pause em clone opt-in passa qa **e2e** (resposta manual do dono pausa 60min; anti-eco não conta a própria resposta do bot como humana); OFF = byte-idêntico.
- **Segurança:** cada PR que toca auth/PII/credencial passa por review de security antes de merge; smoke e2e humano-no-navegador por formato (lição 27/06).

---

## Plano de ondas (resumo; detalhe no campo `ondas`)

- **Onda 1 — Quick wins classe (b):** de-gate UI/rota (planos, frases, destino de alerta, FAQ→`*`). Byte-safe, sem migration.
- **Onda 2 — Fundação per-clone + lacunas de bot atrás de flag OFF:** migration + camada de resolução (UNIÃO env||coluna) + backfill; `consultar_pacote`/`[SEU PACOTE]` no estab; `escalar_para_humano` nos ramos de agenda (flag OFF).
- **Onda 3 — Signup dos 4 formatos + billing-da-agenda derivado + degrade elegante + fila "aguardando agenda".** Espinha da diretriz. Review security + uiux.
- **Onda 4 — human_reply pause universal (opt-in, e2e, go do Bruno por clone).** Maior risco, por último.
- **Parked:** Lembretes (copy+LGPD), antibot, preço real por formato.

