# Postmortem: builder removeu o cartao de confirmacao do clone da Ingrid (cliente pagante)

> **Quem escreve:** `PM`
> **Onde fica:** `docs/postmortems/2026-07-23-ingrid-cartao-removido-pelo-builder.md`
> **Referencia:** SCRUM-108 (este postmortem), PR #480 (fix), PR #491 (guard parcial de persona), SCRUM-113 (raiz — flag divergente do modo real), SCRUM-87 (incidente anterior da mesma divergencia), SCRUM-92 (builder "Monte seu atendente"), SCRUM-120 (aresta do guard prompt_custom)

---

## Resumo executivo

**Data:** 2026-07-23
**Duracao do impacto:** ~2h39min (12:34 UTC ate 15:13 UTC — janela em que o clone rodou sem o guard de agendamento)
**Severidade:** P1 — clone de cliente PAGANTE (R$97/mes) rodando em prod sem o cartao de confirmacao, isto e, sem o guard que obriga o bot a pedir confirmacao (SIM) antes de marcar horario
**Quem detectou:** o time, na propria sessao de trabalho (nao houve alerta automatico)
**Quem mitigou:** PR #480 (fix de codigo) + correcao de dados por SQL manual (versao v21 do prompt)
**Quem escreveu este postmortem:** `PM`

### O que aconteceu (1 paragrafo)

O builder conversacional "Monte seu atendente" (SCRUM-92), ao gerar/aprovar a persona do clone da Ingrid, assou a variante ATENDENTE do prompt — que nao tem o cartao de confirmacao de agendamento — num clone que na verdade roda em modo AGENDA. O prompt em prod caiu de 1779 chars (v19, com cartao) para 1181 chars (v20, sem cartao), deixando ~2h39min o clone sem a mecanica que exige o "SIM" do cliente antes de marcar. Na pratica, nesse periodo o bot poderia efetivar um agendamento sem pedir confirmacao. A causa foi o builder resolver o modo do clone apenas pela flag `modo_atendente_enabled`, que estava divergente do modo REAL do runtime (o clone da Ingrid tem a flag `t` mas roda AGENDA porque `agenda_automatica=true`). O incidente foi corrigido com o PR #480 (builder passou a espelhar o gate duplo do runtime) e o dado em prod foi restaurado manualmente por SQL (v21, `ops:fix-cartao-ingrid`).

---

## Linha do tempo (timeline)

Horarios em UTC, conforme `bot_prompt_versions` em producao (BRT = UTC-3 entre parenteses).

- **2026-07-23 11:39 UTC (08:39 BRT)** — clone da Ingrid na versao **v19** do prompt (1779 chars) — **TEM o cartao de confirmacao**. Estado bom.
- **2026-07-23 12:34 UTC (09:34 BRT)** — builder grava a versao **v20** (1181 chars) — **SEM o cartao**. Inicio da janela de exposicao. O builder assou a variante ATENDENTE num clone que roda AGENDA.
- **~janela** — clone da Ingrid roda ~2h39min sem o guard de agendamento; nenhum alerta automatico dispara.
- **2026-07-23 15:13 UTC (12:13 BRT)** — versao **v21** gravada por SQL manual (`ops:fix-cartao-ingrid`) restaura o prompt com o cartao. Fim da janela. Incidente de dados mitigado.
- **2026-07-23 (mesma sessao)** — PR #480 aberto e mergeado com o fix de codigo (builder passa a espelhar o modo real do runtime + protecao do `cartao_mode` contra regressao). Emojis 🌻/📝 da Ingrid, que estavam fora da allowlist e faziam o PUT dela ser rejeitado, adicionados ao catalogo.

---

## Impacto

- **Cliente afetado:** a cliente (clone da Ingrid) — pagante, R$97/mes.
- **Funcionalidade afetada:** o cartao de confirmacao de agendamento do clone. Durante ~2h39min o bot rodou sem o guard que exige confirmacao explicita (SIM) antes de marcar horario — ou seja, poderia efetivar um agendamento sem confirmacao.
- **Dados perdidos:** nenhum. O prompt anterior (v19) estava preservado em `bot_prompt_versions` e foi a base da restauracao (v21).
- **Agendamentos indevidos observados:** nenhum confirmado no periodo — a janela foi de risco, nao de dano medido.
- **Receita afetada:** nenhuma diretamente; o risco era de confianca/qualidade num clone pagante.
- **Incidente-irmao no mesmo dia:** um teste do builder rodou no clone LIVE do Cirilo (tambem pagante) e sobrescreveu a persona dele 2x. Foi restaurado manualmente ~1h depois. So escapou de dano ao cliente porque o bot do Cirilo estava calado pelo gate de silencio por inadimplencia — sorte, nao salvaguarda.

---

## Causa raiz (5 Whys)

**Por que o clone da Ingrid ficou sem o cartao de confirmacao?**
- O builder gravou (v20) a variante ATENDENTE do prompt, que nao inclui o cartao, num clone que roda em modo AGENDA.

**Por que o builder gerou a variante ATENDENTE num clone de agenda?**
- O `loadCloneContext` do builder resolvia o modo do clone **apenas** pela flag `modo_atendente_enabled`. O clone da Ingrid tem essa flag `t`, entao o builder o tratou como atendente.

**Por que a flag nao refletia o modo real do clone?**
- O runtime (`teste_barbearia.ts`) so roda ATENDENTE quando a flag esta ON **E** `agenda_automatica=false` (gate DUPLO). O clone da Ingrid tem `modo_atendente_enabled=t` **mas** `agenda_automatica=true`, entao o runtime o roda como AGENDA. A flag isolada mente sobre o modo efetivo.

**Por que o builder usava so a flag em vez do gate duplo?**
- A coluna `modo_atendente_enabled` foi tratada, no builder, como fonte de verdade do modo — quando na verdade o modo efetivo depende da combinacao flag + `agenda_automatica`. Essa divergencia entre a flag e o modo real ja existe no sistema e ja tinha mordido antes (SCRUM-87).

**Por que essa divergencia continua espalhada pelo sistema?**
- Nao ha fonte unica do "modo real" do clone: cada consumidor (router, builder, e outros) reimplementa a leitura, e alguns leem so a flag. Falta um resolvedor unico que aplique o gate duplo e seja usado por todos. Isso e a raiz — rastreada em SCRUM-113.

**Causa raiz secundaria (cartao-duplo):** o approve do builder regredia o `cartao_mode` de runtime para baked mesmo com a flag global OFF, o que gerava cartao duplicado em clones que ja tinham o cartao em runtime.

---

## Deteccao

Nao houve alerta automatico. Nao existe monitor que detecte "uma escrita de persona/cartao removeu a mecanica de agendamento de um clone". O problema foi percebido manualmente na sessao de trabalho, ~2h39min depois da escrita ruim. O tempo de deteccao teria sido indefinido se ninguem estivesse olhando — o mesmo vale para o incidente-irmao do Cirilo.

---

## Como foi mitigado (curto prazo)

**Dado em prod (v21):** o prompt do clone da Ingrid foi restaurado por SQL manual a partir da versao boa (v19), gerando a v21 com o carimbo `ops:fix-cartao-ingrid`. O cartao voltou.

**Codigo (PR #480):**
- O builder passou a espelhar o gate DUPLO do runtime: `reallyAtendente = flagAtendente && !isAgendaAutomaticaIntent(...)`. Assim, um clone com a flag ON mas `agenda_automatica=true` deixa de ser tratado como atendente — recebe a variante AGENDA (com cartao).
- Protecao contra a regressao do cartao: `cartaoRuntime = flag global OR clone ja em runtime` — nunca regride runtime para baked, eliminando o cartao-duplo.
- Emojis 🌻/📝 da Ingrid, que estavam fora da allowlist e faziam o PUT dela ser rejeitado, foram adicionados ao catalogo.

---

## Acoes pra evitar que volte (longo prazo)

- [ ] **Fonte unica do "modo real" do clone, usada por TODOS os consumidores** — DRI: `backend-senior` — Rastreio: **SCRUM-113** — Status: **pendente**
  - O #480 fez apenas o BUILDER espelhar o gate duplo (flag + `agenda_automatica`). O router e os demais consumidores ainda leem so a flag `modo_atendente_enabled` — a divergencia (a mesma do SCRUM-87) segue viva para o resto do sistema. Extrair um resolvedor unico do modo efetivo e faze-lo a unica leitura autorizada.

- [x] **Regra: nunca rodar builder / feature-que-escreve-config em clone de cliente real** — DRI: `PM` — Status: **licao registrada**
  - Testes do builder e de qualquer feature que escreve `bot_prompt`/config devem rodar em clone de teste, nunca num clone LIVE de cliente. Os dois incidentes do dia (Ingrid e Cirilo) foram escritas em clones pagantes; o do Cirilo so nao virou dano porque o bot dele estava calado por inadimplencia.

- [~] **Alerta fail-closed para mudanca de persona/cartao que remova a mecanica de agendamento** — DRI: `backend-senior` — Status: **parcialmente entregue (PR #491)**
  - #491 entregou um guard de persona no caminho gcal/test. Falta o alerta que dispare quando qualquer escrita de prompt remover o cartao/guard de agendamento de um clone que agenda — cobrindo o caso deste incidente (deteccao foi 100% manual).

- [ ] **Fechar a aresta do guard `prompt_custom` no approve do builder** — DRI: `backend-senior` — Rastreio: **SCRUM-120** — Status: **pendente**
  - O guard `prompt_custom` no approve ainda tem a aresta descrita no SCRUM-120.

---

## O que funcionou bem

- **Historico versionado salvou o dado:** `bot_prompt_versions` guardava a v19 boa, o que tornou a restauracao (v21) trivial e sem perda.
- **Fix atacou o gate correto:** o #480 espelhou exatamente o gate duplo do runtime no builder, alinhando builder e runtime na mesma regra.
- **Correcao de tabela lateral:** os emojis fora da allowlist (que rejeitavam o PUT da cliente) foram resolvidos junto, evitando um segundo bug latente.

## O que poderia ter sido melhor

- **Deteccao 100% manual:** sem alerta, a janela de exposicao foi ditada por acaso (alguem olhou). Um clone pagante ficou ~2h39min sem o guard sem ninguem saber.
- **Feature-que-escreve-config testada em clones LIVE de pagantes:** os dois incidentes do dia nasceram disso. O do Cirilo escapou por sorte (bot calado por inadimplencia), nao por controle.
- **A flag divergente ja tinha mordido (SCRUM-87) e continuou espalhada:** a licao de "flag != modo real" nao virou fonte unica na primeira vez; voltou como este incidente.

---

## Licoes aprendidas

1. **Uma flag nao e o modo efetivo.** `modo_atendente_enabled` sozinha mente; o modo real depende do gate duplo (flag + `agenda_automatica`). Sempre que uma decisao depender de gate composto, o composto tem que ter uma fonte unica — nao cada consumidor reimplementando.
2. **Consertar so um consumidor nao mata a raiz.** O #480 alinhou o builder, mas o router e os demais ainda leem so a flag. A divergencia segue viva ate a fonte unica (SCRUM-113).
3. **Feature que escreve config de cliente nunca se testa em clone LIVE de pagante.** Usar clone de teste, sempre. O acaso (bot calado do Cirilo) nao e salvaguarda.
4. **Mudanca que remove um guard critico (aqui: o cartao/SIM antes de marcar) precisa de alerta fail-closed.** Se a deteccao depende de alguem olhar, a duracao do impacto e sorte.

---

## O que ficou de divida

- **A raiz nao foi eliminada.** A coluna `modo_atendente_enabled` divergente do modo real do runtime segue lida diretamente pelo router e por outros consumidores. O #480 fez apenas o BUILDER espelhar o modo real. Divergencia rastreada em **SCRUM-113** — e a mesma que ja causou o **SCRUM-87**.
- **Alerta de remocao de mecanica de agendamento** so foi parcialmente entregue (**PR #491**, guard de persona no caminho gcal/test); falta a cobertura geral fail-closed.
- **Guard `prompt_custom` no approve do builder** ainda tem a aresta do **SCRUM-120**.

---

## Anexos

- Fix de codigo: PR #480 (`reallyAtendente = flagAtendente && !isAgendaAutomaticaIntent(...)`; `cartaoRuntime = flag global OR clone ja runtime`)
- Guard parcial de persona: PR #491
- Correcao de dados: versao v21 do prompt em `bot_prompt_versions` (carimbo `ops:fix-cartao-ingrid`)
- Fonte da timeline: tabela `bot_prompt_versions` em producao (v19 -> v20 -> v21, 2026-07-23)
- Cards relacionados: SCRUM-108 (este postmortem), SCRUM-113 (raiz), SCRUM-87 (incidente anterior), SCRUM-120 (aresta prompt_custom), SCRUM-92 (builder)
