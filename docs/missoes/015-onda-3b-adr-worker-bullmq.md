# Missão 015 — Onda 3b: ADR — Worker BullMQ: usar de verdade ou remover?

**DRI:** arquiteto
**Agentes envolvidos:** arquiteto (principal), dev-back (valida jobs existentes e setTimeout espalhados)
**Apetite:** pequeno (1-2 dias para o ADR; implementação é missão separada pós-aprovação)
**Status:** pendente
**Cliente (persona):** time técnico — a resposta determina o destino do setTimeout da entrega de mídia (A7) e de qualquer processamento assíncrono futuro
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (ADR, não feature)

---

## Contexto

A dependência BullMQ está declarada no `package.json` de `apps/worker` mas o worker é vestigial — não há filas reais em uso na plataforma hoje. Paralelamente, a auditoria de 2026-05-19 identificou `setTimeout` fire-and-forget na entrega de mídia (achado A7/C9) como um risco de falha silenciosa. A Missão 012 corrige A7 com um `await` + retry simples como solução temporária, mas a pergunta de fundo permanece: o BullMQ deve ser ativado de verdade para suportar jobs assíncronos (mídia, agendamentos, notificações)? Ou a dependência deve ser removida para simplificar o stack?

## Pergunta arquitetural central

**O `apps/worker` deve:**

- **Opção A:** Ativar BullMQ de verdade — mover entrega de mídia, retry de WAHA e outros jobs para filas gerenciadas (maior confiabilidade; mais complexidade operacional)
- **Opção B:** Remover BullMQ — resolver A7 com `await` + retry inline; eliminar dependência vestigial; simplificar stack (menos infra; aceitável se volume de jobs for baixo)
- **Opção C:** Manter BullMQ como dependência futura mas sem ativar agora — implementar `await` + retry como solução transitória documentada

## O que o ADR deve responder

- Quais jobs hoje usam `setTimeout` ou são fire-and-forget (mapeamento completo)
- Volume esperado de jobs por dia (base: ~100-200 mensagens/dia = quantos jobs de mídia?)
- Custo operacional de manter BullMQ ativo (Redis já está no stack; impacto marginal real?)
- Se Opção A: quais filas, prioridades, políticas de retry
- Se Opção B: plano de remoção limpa da dependência
- Impacto de cada opção no disco do VPS (Redis AOF + BullMQ metadata)

## Solução proposta

- Arquiteto faz grep por `setTimeout` e `fire-and-forget` em `bots/`, `apps/worker/`, `packages/`
- Arquiteto lê `apps/worker/src/` para entender o estado atual
- Arquiteto escreve ADR em `docs/adr/0009-worker-bullmq.md` seguindo template
- Bruno revisa e aprova
- Se Opção A aprovada: missão de implementação criada (numeração 019+); PR-A7 da Missão 012 pode ser simplificada (só logging, sem retry inline)
- Se Opção B aprovada: PR de remoção do BullMQ criada separadamente

## Definition of Done (DoD)

- [ ] Grep completo de `setTimeout` em `bots/` e `apps/` documentado no ADR
- [ ] `docs/adr/0009-worker-bullmq.md` criado seguindo template
- [ ] ADR contém análise de volume de jobs esperado
- [ ] ADR contém recomendação clara com justificativa
- [ ] PR mergeada pelo Bruno (somente o ADR)
- [ ] Missão de implementação criada (se Opção A) ou PR de remoção (se Opção B) antes de fechar

## Fora de escopo

- Qualquer mudança de código (esta missão é só o ADR)
- Decisão sobre painel via API (Missão 014)
- Implementação das filas (missão futura)

## Dependências

- Nenhuma — pode começar em paralelo com Missão 012 e Missão 014
- Leitura de `apps/worker/src/` e grep em `bots/`

## Riscos

- **ADR escolhe Opção A mas Redis não tem memória suficiente no VPS:** mitigação: Missão 011 já levanta uso de RAM; infra pode ajustar `maxmemory` antes da implementação
- **Opção B escolhida e depois surge necessidade de filas:** mitigação: BullMQ pode ser reintroduzido; remoção limpa é reversível

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria de 2026-05-19 identificar BullMQ vestigial (C2) e setTimeout de mídia (A7/C9)
