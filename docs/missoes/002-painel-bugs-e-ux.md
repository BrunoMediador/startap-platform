# Missão 002 — Painel Bugs e UX

> **Escrito por:** `product-owner`
> **Data:** 2026-05-17
> **Status do PR-FAQ:** rascunho — aguardando OK do Bruno

---

## PR-FAQ: Correção de Bugs e Quick Wins de UX no Painel Admin

### FAQ Interna

**Q: Quem se beneficia diretamente?**
A: Bruno (CEO) e Ícaro (vendas) — os dois únicos operadores do painel `gestao.startap.tech`. São eles que qualificam leads, acompanham clientes e disparam clones. UX confusa e bugs nessa interface custam tempo de venda real.

**Q: Por que agora?**
A: Quatro bugs foram identificados em uso real (detalhes técnicos chegam via Fase 1 de diagnóstico do `dev-back`). Além disso, o `dev-front` está auditando UX e há reclamação de fluxo confuso. Deixar bugs acumularem em ferramenta de operação diária gera retrabalho e risco de perda de lead.

**Q: Qual o risco de NÃO fazer?**
A: Bugs que impedem operação normal (cadastro, WAHA, painel) bloqueiam diretamente a capacidade de fechar clientes. UX confusa aumenta tempo de onboarding do Ícaro e chance de erro operacional.

**Q: Quais alternativas foram consideradas?**
A: (1) Corrigir só os bugs, ignorar UX — descartado porque quick wins de UX têm esforço baixo e impacto alto. (2) Rewrite completo do painel — descartado pelo apetite: `server.js` com 1818 linhas é débito conhecido mas não é prioridade agora. (3) Migrar stack (ex: React) — fora de escopo; continua Express + HTML/CSS/JS vanilla.

**Q: O que NÃO está incluso?**
A: Rewrite completo do painel, mudança de stack, refactor de `server.js` além do necessário para os fixes, captação de cliente, qualquer alteração nos bots das matrizes.

**Q: Como medimos sucesso?**
A: Em 7 dias após deploy: (1) zero reports dos 4 bugs identificados em uso real, (2) Bruno e Ícaro conseguem executar o fluxo principal (lead → teste → clone) sem travar, (3) Bruno valida em browser e assina o DoD.

**Q: Qual o apetite?**
A: Médio — 3 a 4 PRs, 1 a 2 semanas.

**Q: Quem é o DRI?**
A: `dev-front` (eixo principal — UX + interface dos fixes visíveis). `dev-back` co-responsável pelos 4 bugs de lógica/API. `product-owner` coordena.

**Q: Riscos?**
A: (1) Regressão em telas que funcionam ao mexer em `server.js` monolítico. (2) Perda de identidade visual já estabelecida ao ajustar CSS/layout. (3) Débito técnico de 1818 linhas pode esconder dependências invisíveis nos fixes.

---

### Decisao do Bruno

- [ ] Aprovado — missão avança para Fase 2 (implementacao)
- [ ] Aprovado com mudancas: _______________
- [ ] Adiar — motivo: _______________
- [ ] Recusar — motivo: _______________

---

---

# Missão 002 — Painel Bugs e UX

**DRI:** `dev-front` (UX + interface) + `dev-back` (bugs de lógica/API)
**Agentes envolvidos:** `dev-front`, `dev-back`, `tester`, `gerente-pr`
**Apetite:** médio (1-2 semanas, 3-4 PRs)
**Status:** rascunho — aguardando OK do Bruno (Fase 1 de diagnóstico em andamento)
**Cliente (persona):** Bruno (CEO) e Ícaro (vendas) — operadores diários do painel admin
**Aberta em:** 2026-05-17
**PR-FAQ:** este mesmo arquivo, seção acima

---

## Contexto

O painel `gestao.startap.tech` é a interface de operação central de Bruno e Ícaro: qualificam leads, acompanham clientes em teste e disparam clones. Quatro bugs foram reportados em uso real (detalhes técnicos pendentes de diagnóstico do `dev-back` na Fase 1). Paralelamente, o `dev-front` está auditando a UX e há reclamação de fluxo confuso. Bugs em ferramenta de operação diária bloqueiam capacidade de venda.

## Solução proposta

- [PLACEHOLDER] Corrigir bug 1: `<descricao virá do dev-back pós-Fase 1>`
- [PLACEHOLDER] Corrigir bug 2: `<descricao virá do dev-back pós-Fase 1>`
- [PLACEHOLDER] Corrigir bug 3: `<descricao virá do dev-back pós-Fase 1>`
- [PLACEHOLDER] Corrigir bug 4: `<descricao virá do dev-back pós-Fase 1>`
- Aplicar 3 quick wins de UX identificados pelo `dev-front` na auditoria (Fase 3)
- [CONDICIONAL] Avaliar Fase 4 de overhaul maior se quick wins não resolverem a reclamação de UX

## Definition of Done (DoD)

- [ ] [PLACEHOLDER] Bug 1 corrigido e verificável: `<criterio mensuravel>`
- [ ] [PLACEHOLDER] Bug 2 corrigido e verificável: `<criterio mensuravel>`
- [ ] [PLACEHOLDER] Bug 3 corrigido e verificável: `<criterio mensuravel>`
- [ ] [PLACEHOLDER] Bug 4 corrigido e verificável: `<criterio mensuravel>`
- [ ] Quick wins de UX aplicados: Bruno e Ícaro conseguem executar fluxo lead → teste → clone sem travar
- [ ] Identidade visual existente preservada (nenhum componente visual quebrado vs. estado anterior)
- [ ] Smoke test: telas de leads, clones e configuração de WAHA carregam sem erro de console
- [ ] Build local passa (`npm run build --workspaces` ou `node painel-admin/server.js` sem crash)
- [ ] Tester rodou checklist completo e registrou resultado (`APROVADO PARA PR`)
- [ ] Bruno validou em browser (Chrome desktop + mobile) e aprovou
- [ ] PR mergeada pelo Bruno
- [ ] Deploy validado em producao (`https://gestao.startap.tech` acessível, zero erro novo em logs)

## Fora de escopo

- Rewrite completo do painel (`server.js`)
- Mudança de stack (continua Express + HTML/CSS/JS vanilla)
- Refactor de `server.js` além do estritamente necessário para os fixes (débito conhecido — missão futura)
- Captação de cliente / landing page
- Qualquer alteração nos bots das matrizes ou Lola
- Fase 4 de overhaul maior (só entra no scope se Bruno aprovar após ver resultado dos quick wins)

## Dependências

- Nenhuma missão bloqueante anterior
- Resultado do diagnóstico do `dev-back` (Fase 1) deve preencher os PLACEHOLDERs antes de 002-B começar
- Auditoria do `dev-front` (Fase 1) deve listar os 3 quick wins antes de 002-C começar

## Riscos

- **Regressão em telas que funcionam:** `server.js` tem 1818 linhas — mitigação: tester executa smoke test em TODAS as telas, não apenas nas alteradas
- **Perda de identidade visual:** mitigação: `dev-front` documenta os componentes visuais atuais antes de tocar em CSS; Bruno valida screenshot before/after
- **Débito técnico esconde dependências:** mitigação: `dev-back` mapeia no diagnóstico (Fase 1) quais rotas tocam nos 4 bugs antes de propor fix

## Plano de quebra (apetite médio — 3-4 PRs)

1. **002-A: Diagnóstico (Fase 1)** — `dev-back` documenta os 4 bugs com root cause + `dev-front` lista 3 quick wins de UX. Sem código. Resultado preenche PLACEHOLDERs desta missão. Bruno aprova antes de 002-B.
2. **002-B: Correção dos 4 bugs** — `dev-back` implementa fixes. [PLACEHOLDER: detalhes pós-Fase 1]
3. **002-C: Quick wins de UX** — `dev-front` aplica os 3 quick wins identificados. [PLACEHOLDER: detalhes pós-auditoria]
4. **002-D: Validação e PR final** — `tester` executa checklist completo. `gerente-pr` consolida e abre PR para revisão do Bruno.

> Fase 4 (overhaul maior de UX) só entra em escopo se Bruno aprovar após validar resultado de 002-C.

## Atualizações (log)

- **2026-05-17:** Aberta pelo `product-owner` como rascunho durante Fase 1 de diagnóstico. PLACEHOLDERs aguardam resultado de `dev-back` e `dev-front`. Aguardando OK do Bruno.
