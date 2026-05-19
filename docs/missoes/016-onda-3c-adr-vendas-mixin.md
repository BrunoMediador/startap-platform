# Missão 016 — Onda 3c: ADR — Como extrair lógica comum dos bots de vendas?

**DRI:** arquiteto
**Agentes envolvidos:** arquiteto (principal), dev-back (valida duplicação real no código)
**Apetite:** pequeno (1 dia para o ADR; implementação é missão separada pós-aprovação)
**Status:** pendente
**Cliente (persona):** dev-back — duplicação aumenta risco de divergência entre `teste_vendas` e `teste_vendas_barbearia`; bug corrigido em um exige correção manual no outro
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (ADR, não feature)

---

## Contexto

A auditoria de 2026-05-19 (achado C3) identificou ~200 linhas de lógica de vendas duplicadas entre `bots/teste_vendas.ts` e `bots/teste_vendas_barbearia.ts`. Quando um bug é encontrado (ex: o `setTimeout` de mídia — A7), precisa ser corrigido nos dois arquivos separadamente, aumentando o risco de divergência. A missão pergunta: como extrair essa lógica comum sem violar o princípio de isolamento de bots (memória `project_arquitetura_fluxos` — "mudança em um bot não pode quebrar outro")?

## Pergunta arquitetural central

**Como lidar com a duplicação:**

- **Opção A:** Extrair `VendasMixin` em `packages/bots-common/src/vendas-mixin.ts` — ambos os bots importam o mixin; mudança é centralizada (menos duplicação; acoplamento explícito via package)
- **Opção B:** Extrair em `bots/shared/vendas.ts` dentro do mesmo app — import local; sem novo package (mais simples; ainda acoplado mas sem overhead de workspace)
- **Opção C:** Manter duplicação mas com teste de contrato — garantir que os dois arquivos se comportam igual via teste compartilhado (sem refactor; duplicação explicitamente gerenciada)

## O que o ADR deve responder

- Quais exatamente são as ~200 linhas duplicadas (lista de funções/blocos)
- A lógica do `teste_vendas_barbearia` é um superset do `teste_vendas` ou têm desvios?
- Se há desvios: o mixin suportaria parametrização ou exigiria overrides?
- Impacto no princípio de isolamento (memória `project_arquitetura_fluxos`): um bug no mixin quebra ambos os bots ao mesmo tempo?
- Qual opção o arquiteto recomenda e por quê

## Solução proposta

- Arquiteto faz diff entre `bots/teste_vendas.ts` e `bots/teste_vendas_barbearia.ts` para mapear exatamente o que está duplicado
- Arquiteto escreve ADR em `docs/adr/0010-vendas-mixin.md` seguindo template
- Bruno revisa e aprova
- Se Opção A ou B aprovada: missão de implementação criada antes de fechar esta missão

## Definition of Done (DoD)

- [ ] Diff das funções duplicadas documentado no ADR (com nomes de função e linhas)
- [ ] `docs/adr/0010-vendas-mixin.md` criado seguindo template
- [ ] ADR responde explicitamente sobre o risco de isolamento (princípio dos bots)
- [ ] ADR contém recomendação clara com justificativa
- [ ] PR mergeada pelo Bruno (somente o ADR)
- [ ] Missão de implementação criada (se Opção A ou B) antes de fechar

## Fora de escopo

- Qualquer mudança de código (esta missão é só o ADR)
- Refactor da lógica de barbearia (escopo diferente)
- Merge dos dois bots em um só (fora do modelo de produto atual)

## Dependências

- Nenhuma — pode começar em paralelo com Missões 012, 014 e 015
- Leitura de `bots/teste_vendas.ts` e `bots/teste_vendas_barbearia.ts`

## Riscos

- **Diff revela mais de 200 linhas duplicadas:** mitigação: ADR ajusta o estimate; não altera a decisão arquitetural
- **Opção A aprovada mas introduz acoplamento inesperado:** mitigação: teste de contrato (Opção C) pode ser adicionado como camada de segurança mesmo após extrair o mixin

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria de 2026-05-19 identificar VendasMixin como débito C3
