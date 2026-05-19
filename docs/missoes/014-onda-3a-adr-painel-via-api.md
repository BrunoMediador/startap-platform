# Missão 014 — Onda 3a: ADR — Painel acessa API ou banco direto?

**DRI:** arquiteto
**Agentes envolvidos:** arquiteto (principal), dev-back (valida viabilidade técnica), product-owner (valida impacto de produto)
**Apetite:** pequeno (2 dias para o ADR; implementação é missão separada pós-aprovação)
**Status:** pendente
**Cliente (persona):** time técnico — a decisão arquitetural aqui determina o escopo de refactors futuros e o isolamento de responsabilidades
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (ADR, não feature)

---

## Contexto

O `painel-admin/server.js` acessa o Postgres diretamente com `pg.Pool`, bypassa completamente a API TypeScript em `apps/api/`. Isso cria dois caminhos de dados paralelos para as mesmas entidades (`bot_config`, `flow_clones`, `leads_*`), duplica lógica de autenticação e validação, e dificulta testes. A auditoria de 2026-05-19 (achado C1) indica que o painel tem ~3161 linhas de queries SQL diretas. Esta missão produz apenas o ADR — nenhum código é alterado.

## Pergunta arquitetural central

**O painel-admin deve:**

- **Opção A:** Migrar 100% para chamar `apps/api` (elimina bypass do banco; prazo estimado: grande, 2-3 semanas)
- **Opção B:** Manter híbrido — painel chama API para operações críticas (escrita), mantém leitura direta para performance (menor prazo, risco de proliferação)
- **Opção C:** Manter painel com acesso direto ao banco mas com melhorias pontuais (sem migração, só hardening — menor esforço, dívida permanece)

## O que o ADR deve responder

- Qual opção o arquiteto recomenda e por quê (com trade-offs explícitos)
- Quais endpoints do painel já têm equivalente em `apps/api` e quais precisariam ser criados
- Estimativa de esforço por opção (número de endpoints, linhas de SQL a migrar)
- Impacto no deploy (painel e API são containers separados; mudança de URL base afeta frontend)
- Risco de regressão por opção
- Se Opção A ou B for escolhida: plano de fases (não tudo de uma vez)

## Solução proposta

- Arquiteto lê `painel-admin/server.js` e `apps/api/src/router.ts` para mapear sobreposições
- Arquiteto escreve ADR em `docs/adr/0008-painel-acesso-banco.md` seguindo template `ADR.md`
- Bruno revisa e aprova a decisão
- Se aprovado: arquiteto cria missão de implementação (numeração 019+) com fases sequenciais

## Definition of Done (DoD)

- [ ] `docs/adr/0008-painel-acesso-banco.md` criado seguindo template
- [ ] ADR contém mapeamento de pelo menos os 20 endpoints mais críticos do painel
- [ ] ADR contém estimativa de esforço por opção
- [ ] ADR contém recomendação clara com justificativa
- [ ] PR mergeada pelo Bruno (somente o ADR — sem código de aplicação)
- [ ] Se Bruno aprovar Opção A ou B: missão de implementação criada antes de fechar esta missão

## Fora de escopo

- Qualquer mudança de código (esta missão é só o ADR)
- Decisão sobre BullMQ (Missão 015)
- Decisão sobre VendasMixin (Missão 016)

## Dependências

- Nenhuma — pode começar em paralelo com Missão 012 (ondas independentes)
- Leitura de `painel-admin/server.js` (3161 linhas) e `apps/api/src/router.ts`

## Riscos

- **ADR recomenda Opção A e esforço é maior que o esperado:** mitigação: fases pequenas com entrega incremental; nenhuma fase é "big bang"
- **Bruno não aprova nenhuma opção:** mitigação: ADR apresenta trade-offs claros; Bruno pode solicitar Opção C (manter status quo) — isso também é uma decisão válida e deve ser documentada

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria de 2026-05-19 identificar bypass do banco como débito C1
