# ADR 0028 — Padronização de telefones (DDI BR garantido; 9º dígito PARQUEADO)

- **Status:** ACEITO (decisão do Bruno em 2026-06-25)
- **Data:** 2026-06-24
- **Autor:** 01-arquiteto
- **Aprovado por:** Bruno
- **DRI:** PM / 02-backend-senior
- **Relacionados:** ADR 0018 (`tenant_id` — identidade por cliente; `flow_clones` como âncora de tenant), ADR 0015 (reconexão self-service WAHA pelo portal — quem chama o `request-code`), ADR 0007 (isolamento por `slot`). O HMAC/identidade do trial (que usa `canonicalE164`) **fica SEPARADO e intocado** — este ADR não muda a derivação de identidade.

---

## Contexto

O telefone do cliente é dado de **identidade e de pareamento** — é o que vai pro `request-code` do WAHA (pareamento por código), pro alerta ao dono (`toChatId`) e pro cadastro/edição no painel de gestão. Hoje **não há um formato canônico único** e isso já causa falha de pareamento real em produção.

### Os 3 formatos que coexistem em `flow_clones.cliente_telefone`

A coluna guarda o mesmo dado em **três formas diferentes**, dependendo de *quem gravou*:

1. **Signup/trial** → grava via `canonicalE164` → **12 dígitos, SEM o 9** (a função remove o 9º dígito do celular; ela existe pra identidade/HMAC do trial, onde unificar COM/SEM-9 é desejável).
2. **Gestão (painel-admin)** → grava **CRU**, sem nenhuma normalização → pode vir **sem DDI 55**, com ou sem 9, com lixo de digitação. **É o pior ofensor.**
3. **Backfill antigo (migration 050)** → gravou **COM o 9, 13 dígitos**.

### Dois helpers divergentes + `maskPhone` triplicado

- `canonicalE164` (`@startap/core`) — **remove** o 9. Correta pra identidade/HMAC; **errada** pra pareamento.
- `meIdToDigits` — **mantém** o 9.
- `maskPhone` está **duplicado em 3 lugares** (risco de divergência de mascaramento/LGPD).

### Onde quebra (incidente real)

O `request-code` do WAHA **exige E.164 com DDI**. Ele recebia o número **CRU** do cadastro de gestão; sem o `55` na frente, o WAHA **não pareia**. Caso concreto: clone de teste cadastrado como `3599247411` → o número real é `553599247411`; sem o `55` prependido, o pareamento **FALHA**. O alerta ao dono (`client-alert.ts` → `toChatId`) tem **exatamente o mesmo risco**: monta o JID a partir do número gravado; sem DDI o destino fica inválido.

### Survey do banco (estado real)

- Das colunas de **identidade** (`flow_clones.cliente_telefone`, `flow_clones.alert_owner_phone`, `alert_recipients.phone`), **apenas 1 cadastro** estava fora do padrão. `alert_owner_phone` e `alert_recipients` **já foram limpos**.
- **Pagantes estão íntegros e variados** (cada um num formato que **funciona/pareia hoje**):
  - **Cirilo** `5511979630828` — 13 díg, **COM 9**.
  - **Samuel** `5535991746797` — 13 díg, **COM 9**.
  - **Seven 7** `556599453860` — 12 díg, **SEM 9**.
- **Telemetria** (`model_usage`, `message_log`, `flow_pauses`) contém **JIDs de grupo (`@g.us`)** e ruído não-telefônico → **FORA de qualquer backfill**.

### Princípio que enquadra tudo (Bruno)

> **"O que já funciona não se toca."** Nenhuma migration altera o 9º dígito de números de clientes que já pareiam. Os pagantes acima ficam **intocados, byte-a-byte. Zero risco a pagante.** O risco de incidente mora justamente na unificação do 9 — que fica **PARQUEADA** (Fase 3), só com novo ADR + confirmação com o WAHA.

### Restrições que moldam a decisão (constantes do projeto)

- **Sem ORM.** Schema/normalização são responsabilidade explícita do app; qualquer backfill é migration SQL raw **idempotente, aditiva, forward-only e reversível** versionada por `schema_migrations` (`scripts/migrate.sh`).
- **Isolamento P0 (ADR 0018):** dados de telefone vivem por `slot`/`tenant_id`. Backfill nunca cruza tenant.
- **LGPD:** telefone **nunca** logado em claro — só `phoneHint` mascarado.
- **Front nunca normaliza:** a verdade do formato é do **backend**, no uso e na entrada.

---

## Decisão

**O formato canônico é E.164 BR só-dígitos COM DDI `55`. O 9º dígito é PRESERVADO como foi gravado — NÃO unificamos COM-9 vs SEM-9 agora.** A garantia do DDI e a validação do DDD ficam concentradas num **helper único** chamado **no backend**, no **uso** e na **entrada**; o front nunca é fonte de verdade.

Cravamos cinco pontos:

1. **Canônico = E.164 BR só-dígitos COM DDI 55**, sem `+`, sem máscara. O **9º dígito é mantido exatamente como gravado** — não inferimos, não adicionamos, não removemos. COM-9 e SEM-9 **coexistem** por enquanto (é o que pareia hoje pra cada pagante).

2. **Helper único `ensureDddBr`** em `@startap/core` (`packages/core/src/phone.ts`). Contrato:
   - **Garante o DDI 55**: prepend do `55` **somente** num número nacional de **10–11 dígitos sem 55** (fixo 10 / celular 11). Número que já começa com `55` válido é mantido.
   - **Valida o DDD** contra a **whitelist de DDDs BR**; DDD inexistente → `null`.
   - **Retorna `null` pra ambíguo/lixo**: JID de grupo (`@g.us`), prefixo estrangeiro, comprimento impossível, não-numérico.
   - **NUNCA adiciona nem remove o 9.** Esse é o limite duro que separa `ensureDddBr` de `canonicalE164`.
   - **NÃO usar `canonicalE164` pra isto** — ela remove o 9 e quebraria o pareamento de Cirilo/Samuel. `canonicalE164` permanece **EXCLUSIVA** da identidade/HMAC do trial.

3. **Normalização sempre no BACKEND**, em dois pontos:
   - **No USO** — `request-code` do WAHA em `portal-conexao.ts` e alerta ao dono em `client-alert.ts` (montagem do `toChatId`): passam o número por `ensureDddBr` antes de falar com o WAHA. Resolve o bug de pareamento.
   - **Na ENTRADA** — gestão (`painel-admin/server.js`, rotas `POST`/`PATCH`/`bind` de telefone): hoje grava **CRU** (pior ofensor) → passa a normalizar com `ensureDddBr` antes de persistir. **Nunca confiar no front.**

4. **"O que já funciona não se toca"** (princípio explícito do Bruno): nenhuma migration mexe no 9º dígito de números que já pareiam. **Cirilo / Samuel (COM 9) e Seven 7 (SEM 9) ficam intocados.** Backfill (Fase 2) só atua sobre **registro de identidade fora do padrão** (o 1 cadastro do survey) — **prepend de DDI / descarte de lixo, jamais ±9**.

5. **PARQUEADO (Fase 3, exige novo ADR + decisão do Bruno + confirmação com o WAHA):** unificar o 9º dígito (escolher COM **ou** SEM e migrar tudo pra um lado só). **É onde mora o risco de incidente em pagante** — pareamento WAHA é sensível ao 9, e o comportamento certo precisa ser confirmado contra o WAHA antes de tocar qualquer número que funciona. **Não fazer agora.**

---

## `ensureDddBr` vs `canonicalE164` (a fronteira que não pode borrar)

| | `ensureDddBr` (NOVO) | `canonicalE164` (existente) |
|---|---|---|
| Propósito | **Pareamento / alerta / cadastro** (uso operacional do número) | **Identidade / HMAC do trial** (deduplicar cadastro) |
| 9º dígito | **PRESERVA** (nunca ±9) | **REMOVE** o 9 |
| DDI 55 | garante (prepend em nacional 10–11 sem 55) | garante |
| DDD inválido / lixo / `@g.us` / estrangeiro | `null` | (escopo de identidade) |
| Onde é chamado | `portal-conexao.ts`, `client-alert.ts`, `painel-admin/server.js` | derivação de identidade do trial — **intocado** |

Misturar os dois é o bug raiz: usar `canonicalE164` no pareamento removeria o 9 de Cirilo/Samuel e quebraria a conexão deles. **São funções diferentes pra propósitos diferentes; não se substituem.**

---

## Alternativas consideradas

### Opção A — DDI garantido + 9 preservado + helper único `ensureDddBr` no backend ← **ESCOLHIDA**
- **Pros:** resolve o bug de pareamento (DDI) e estanca o pior ofensor (gestão grava CRU) **sem tocar em nenhum número que já funciona**; reversível; zero risco a pagante; separa de vez identidade (`canonicalE164`) de pareamento (`ensureDddBr`).
- **Contras:** COM-9 e SEM-9 seguem coexistindo (não há um valor único e "limpo" no banco). Aceito — uniformizar o 9 é o passo arriscado, fica parqueado.
- **Escolhida porque:** é a evolução incremental de menor risco que mata a falha real, e respeita "o que já funciona não se toca".

### Opção B — Unificar tudo pro SEM-9 via `canonicalE164`
- **Pros:** um único formato no banco; reusa helper existente.
- **Contras:** **quebra o pareamento de Cirilo e Samuel** (ambos COM 9 hoje). Mexer no telefone de pagante é exatamente o que o princípio do Bruno proíbe.
- **Descartada porque:** risco direto de incidente em pagante. Inaceitável.

### Opção C — Unificar tudo pro COM-9
- **Pros:** um único formato no banco.
- **Contras:** **mexe no Seven 7** (SEM 9 hoje) e em qualquer outro SEM-9 que pareia; inferir o 9 de um celular é heurística falível; risco em pagante.
- **Descartada porque:** mesma razão da B — toca número que funciona. Fica **PARQUEADO** (Fase 3) só com novo ADR + confirmação com o WAHA.

### Opção D — Status quo (não fazer nada)
- **Pros:** zero esforço.
- **Contras:** a gestão **continua gravando lixo** (sem DDI / com erro de digitação) e o `request-code`/alerta **continua falhando** pra todo cadastro feito por gestão sem DDI. O bug volta no próximo onboarding.
- **Descartada porque:** o bug é real e recorrente; não estancar a entrada é deixar a dívida crescer.

---

## Guardrails (invariantes deste ADR)

- **Helper único compartilhado.** `ensureDddBr` vive em `@startap/core`; o painel-admin **espelha 1:1** (mesma whitelist de DDD, mesma regra de prepend) — sem segunda implementação que divirja.
- **Nunca logar telefone em claro.** Toda saída de log usa `phoneHint`/`maskPhone` (LGPD). Consolidar os **3 `maskPhone`** num só é parte da Fase 1.
- **Backfill (quando houver) é forward-only, idempotente e reversível**, com `phoneHint` antes→depois no log da migration, e **só roda DEPOIS** de entrada+uso já corrigidos (Fase 0/1). Nenhum `DROP/DELETE/TRUNCATE`. Nenhum ±9.
- **Telemetria fica fora.** `model_usage`/`message_log`/`flow_pauses` têm JID de grupo e ruído → nunca entram em backfill de identidade.

---

## Plano faseado (rollout incremental, reversível)

### Fase 0 — Helper + uso + entrada (em implementação, PR separado) — **sem migration**
- Cria `ensureDddBr` em `packages/core/src/phone.ts` (prepend DDI nacional 10–11; whitelist DDD; `null` pra `@g.us`/estrangeiro/lixo; **nunca ±9**).
- Aplica no **uso**: `portal-conexao.ts` (request-code WAHA) e `client-alert.ts` (`toChatId`).
- Aplica na **entrada**: `painel-admin/server.js` (`POST`/`PATCH`/`bind`) normaliza antes de gravar.
- **Resolve o bug de pareamento e estanca o pior ofensor.** Nenhum dado existente é tocado. Reversível: reverter os call-sites.
- **Risco:** BAIXO. Só adiciona normalização no caminho de uso/entrada; não migra nada.

### Fase 1 — Normalização de toda entrada + consolidar `maskPhone`
- Garante que **todo** ponto de entrada de telefone no backend passa por `ensureDddBr` (varredura de call-sites).
- Funde os **3 `maskPhone`** num único helper em `@startap/core` (LGPD/consistência de log).
- **Risco:** BAIXO-MÉDIO (toca mais call-sites; revisar com `qa-tester`). Sem migration.

### Fase 2 — Backfill MÍNIMO de identidade (exige OK do Bruno) — migration aditiva forward-only
- **Só** o(s) registro(s) de **identidade fora do padrão** (o 1 cadastro do survey): prepend de DDI / descarte de lixo. **Jamais ±9. Pagantes intocados.**
- Higiene de telemetria é **opcional** e, se feita, com **whitelist de DDD + exclusão de JIDs** — nunca toca número que funciona.
- Migration **idempotente** (roda 2×, 2ª é no-op), com `phoneHint` antes→depois no log e bloco de **rollback** no cabeçalho. **Roda só DEPOIS de Fase 0/1** (entrada+uso corrigidos) pra não re-sujar.
- **Risco:** BAIXO (1 registro, escopado por `slot`, validado por survey). Aprovação explícita do Bruno antes de aplicar.

### Fase 3 — PARQUEADA: unificação do 9º dígito — **só com NOVO ADR**
- Escolher COM **ou** SEM-9 e migrar tudo pra um lado só.
- **Exige:** novo ADR + decisão do Bruno + **confirmação do comportamento contra o WAHA** (como o WAHA pareia/normaliza o 9). É o passo de maior blast radius (mexe em pagante).
- **Não fazer sem isso.**

---

## Consequências

### Positivas
- O `request-code` do WAHA e o alerta ao dono passam a receber **sempre** E.164 com DDI → fim da falha de pareamento por número sem `55`.
- A gestão para de gravar lixo (DDI ausente / erro de digitação) na origem — corta a dívida no ponto onde ela nasce.
- Identidade (`canonicalE164`) e pareamento (`ensureDddBr`) ficam **explicitamente separados** — some a tentação de reusar a função errada.
- **Zero risco a pagante:** nenhum número que funciona é alterado (princípio "o que já funciona não se toca").
- `maskPhone` único → mascaramento LGPD consistente em todo log.

### Negativas / trade-offs
- O banco continua com **COM-9 e SEM-9 coexistindo** — não há um valor único "limpo". Aceito de propósito; uniformizar é arriscado e fica parqueado.
- O painel-admin precisa **espelhar** `ensureDddBr` (whitelist de DDD + regra de prepend) — disciplina pra os dois não divergirem (mitigado pelo guardrail de helper único e por teste).
- A unificação do 9 (Fase 3) fica em aberto — qualquer relatório que assuma "1 formato por número" precisa lidar com os dois até lá.

### Neutras
- Telemetria (`model_usage`/`message_log`/`flow_pauses`) fica **fora** por design (JIDs de grupo, ruído). Esperado, não é dívida.

---

## Validação (DoD deste ADR)

- `ensureDddBr` em `@startap/core`: prepend `55` em nacional 10–11 sem 55; **mantém** o 9 em todos os casos; `null` pra `@g.us`/estrangeiro/DDD inválido/lixo. Coberto por `vitest`.
- `request-code` (`portal-conexao.ts`) e alerta (`client-alert.ts`) recebem E.164 com DDI após `ensureDddBr` — pareamento do caso `3599247411 → 553599247411` passa.
- Gestão (`painel-admin/server.js` `POST`/`PATCH`/`bind`) **não grava mais CRU** — número persistido sempre normalizado.
- **Pagantes byte-a-byte intocados:** Cirilo `5511979630828`, Samuel `5535991746797`, Seven 7 `556599453860` (diff no banco = 0 nessas linhas).
- `maskPhone` único; nenhum log emite telefone em claro (LGPD).
- Backfill (Fase 2, se/quando rodar): idempotente, forward-only, `phoneHint` antes→depois, bloco de rollback, **nenhum ±9**, nenhum `DROP/DELETE/TRUNCATE`.

## Rollback
- **Fase 0/1:** reverter os call-sites (helper passa a não ser chamado) → comportamento volta ao atual. Sem dado migrado pra desfazer.
- **Fase 2:** migration de reversão separada restaura o `phoneHint` registrado antes→depois do(s) registro(s) tocado(s). Forward-only, nunca no mesmo release.
- **Fase 3:** parqueada — não há o que reverter (não será feita sem novo ADR).

## O que precisa de decisão/aprovação do Bruno
1. ✅ **Formato canônico = E.164 BR COM DDI 55; 9 preservado** (decidido 2026-06-25).
2. ✅ **`ensureDddBr` como helper de pareamento; `canonicalE164` exclusiva de identidade** (decidido).
3. **OK explícito pra rodar o backfill da Fase 2** (1 registro de identidade fora do padrão) antes do pipeline aplicar.
4. **Não reabrir a Fase 3** (unificar o 9) sem novo ADR + confirmação com o WAHA.

## Referências
- `packages/core/src/phone.ts` — `ensureDddBr` (NOVO, Fase 0) + `canonicalE164` (existente, identidade).
- `portal-conexao.ts` — `request-code` do WAHA (uso; normaliza na Fase 0).
- `client-alert.ts` — alerta ao dono / `toChatId` (uso; normaliza na Fase 0).
- `painel-admin/server.js` — `POST`/`PATCH`/`bind` de telefone (entrada; pior ofensor; normaliza na Fase 0).
- migration 050 — backfill antigo que gravou COM 9 (origem de um dos 3 formatos).
- ADR 0018 — `tenant_id`/`flow_clones` como âncora de tenant (escopo de qualquer backfill).
- ADR 0015 — reconexão self-service WAHA pelo portal (quem dispara o pareamento).
- `scripts/migrate.sh` — runner idempotente, `schema_migrations` (Fase 2).
