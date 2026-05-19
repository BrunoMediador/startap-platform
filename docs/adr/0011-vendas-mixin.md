# ADR 0011: VendasMixin — como extrair lógica comum sem quebrar isolamento?

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0011-vendas-mixin.md`

---

**Status:** proposta — aguardando aprovação de Bruno
**Data:** 2026-05-19
**Autor:** arquiteto
**Aprovado por:** pendente

---

## Contexto

`apps/api/src/bots/teste_vendas.ts` (444 linhas) e `apps/api/src/bots/teste_vendas_barbearia.ts` (683 linhas) compartilham um bloco de lógica de vendas praticamente idêntico. O diff real, linha a linha:

| Função | `teste_vendas.ts` | `teste_vendas_barbearia.ts` | Diferença |
|---|---|---|---|
| `parseMarker` | linhas 29-49 | linhas 31-51 | **idêntica** |
| `ParsedMarker` interface | linhas 21-27 | linhas 23-28 | **idêntica** |
| `ConversationState` interface | linhas 52-55 | linhas 54-57 | **idêntica** |
| `parseConversationState` | linhas 57-78 | linhas 60-82 | **idêntica** |
| `formatPrice` | linha 80-82 | linhas 85-87 | **idêntica** |
| `formatCoursesForPrompt` | linhas 84-95 | linhas 90-101 | **idêntica** |
| `formatMediaForPrompt` | linhas 97-110 | linhas 104-117 | **idêntica** |
| `sanitizar` / `sanitizarResposta` | linhas 172-184 | linhas 340-352 | **idêntica** (nome diferente) |
| `handleMarker` | linhas 325-441 | linhas 560-678 | **quase idêntica** — `barbearia` recebe `telefone` no input mas não usa; mesma lógica |

Total de duplicação: ~170 linhas (funções livres + tipos) + ~120 linhas de `handleMarker` = ~290 linhas duplicadas.

O `teste_vendas_barbearia` tem lógica **adicional** exclusiva: integração com Google Calendar, cálculo de disponibilidade de agenda, `SERVICES`/`WORK` hardcoded, e o fluxo de cancelamento de agendamento. Essa lógica não existe no `teste_vendas` — é um superset real, não uma variação paramétrica.

**Restrição crítica:** memória `project_arquitetura_fluxos` e Regra de Ouro 7 impõem isolamento de bots. Um bug introduzido em código compartilhado quebra dois bots simultaneamente. Isso é pior do que duplicação, porque duplicação contém falhas enquanto código compartilhado as propaga.

**Restrição de modelo:** memória `project_arquitetura_fluxos` diz "só 4 fluxos, separadinho com tabelas dedicadas. Não inventar fluxos novos". Um novo pacote `packages/bots-common` seria infraestrutura nova que aumenta a superfície de manutenção.

---

## Decisão

**Opção C escolhida: extrair funções puras em `apps/api/src/bots/lib/vendas-utils.ts`.**

As ~170 linhas de funções sem estado (`parseMarker`, `parseConversationState`, `formatPrice`, `formatCoursesForPrompt`, `formatMediaForPrompt`, `sanitizar`) e os tipos (`ParsedMarker`, `ConversationState`) são extraídos para um módulo local dentro do mesmo `apps/api`. `handleMarker` permanece privado em cada bot — é lógica com efeitos colaterais (WAHA, memória) e a assinatura já divergiu. Sem herança, sem novo pacote, sem acoplamento de infraestrutura.

---

## Alternativas consideradas

### Opção A — Status quo: manter duplicação
- **Como funcionaria:** nenhuma mudança.
- **Pros:** isolamento perfeito — bug em um bot não afeta o outro; zero risco de regressão imediata.
- **Contras:** correção de bug exige dois PRs; funções já divergiram nominalmente (`sanitizar` vs `sanitizarResposta`) — tende a piorar.
- **Descartada porque:** com `handleMarker` e `sanitizar` já divergindo por nome, a duplicação está caminhando para inconsistência. O risco de divergência supera o custo da extração controlada.

### Opção B — Classe `VendasBotBase extends BotBase`
- **Como funcionaria:** nova classe intermediária com `handleMarker` e utilitários; ambos os bots herdam dela.
- **Pros:** consolidação em herança OOP; padrão familiar ao código existente (`BotBase` já funciona assim).
- **Contras:** `handleMarker` tem efeitos colaterais (WAHA, `appendMemory`) e assinatura com leve divergência entre os bots — na barbearia recebe `telefone` extra. Herança de métodos stateful é risco real: um override incorreto quebra ambos. Lógica específica da barbearia (gcal, agenda) pode "vazar" para a classe base por pressão de dev.
- **Descartada porque:** herança com métodos stateful e assinatura divergente é fragilidade. A Regra 7 protege contra acoplamento não-intencional; herança cria acoplamento estrutural.

### Opção C — Extração em `apps/api/src/bots/lib/vendas-utils.ts` ← **ESCOLHIDA**
- **Como funcionaria:** funções puras e tipos movidos para arquivo local em `apps/api/src/bots/lib/`. Ambos os bots fazem `import` do mesmo módulo. `handleMarker` permanece privado em cada classe. Sem novo pacote.
- **Pros:** elimina duplicação de ~170 linhas; correção de bug em `parseMarker` ou `formatCoursesForPrompt` aplica nos dois bots; funções puras são trivialmente testáveis; sem herança stateful; sem novo pacote de workspace.
- **Contras:** um bug introduzido nas funções puras afeta ambos os bots — mas funções puras têm superfície de falha menor e são testáveis isoladamente.
- **Escolhida porque:** funções puras sem efeitos colaterais têm risco baixo de regressão em cascata. O isolamento da Regra 7 protege contra efeitos em runtime — funções puras não têm runtime state. `handleMarker` (stateful) permanece isolado em cada bot.

### Opção D — Classe única `VendasBot` com flag `tipoVenda`
- **Como funcionaria:** arquivo único `vendas.ts` com `if (this.tipo === 'curso+barbearia') { ... }`.
- **Pros:** uma classe, um arquivo.
- **Contras:** lógica condicional cresce com o tempo; testar combinações é exponencial; viola o modelo mental do produto (cada bot é um arquivo separado); refatoração futura muito mais difícil.
- **Descartada porque:** conflita com o princípio de isolamento e com o modelo de produto declarado em `project_arquitetura_fluxos`.

---

## Consequências

### Positivas
- `parseMarker`, `parseConversationState`, `formatPrice`, `formatCoursesForPrompt`, `formatMediaForPrompt`, `sanitizar` — mantidas em um único lugar, cobertas por um único conjunto de testes unitários.
- Bug corrigido em `vendas-utils.ts` aplica automaticamente nos dois bots no mesmo PR.
- `teste_vendas.ts` fica ~170 linhas menor; `teste_vendas_barbearia.ts` fica ~170 linhas menor.
- Adicionar um terceiro bot de vendas no futuro custa importar o mesmo módulo — sem copiar código.

### Negativas / trade-offs
- Bug em função pura compartilhada afeta ambos os bots simultaneamente. Mitigação: testes unitários obrigatórios no mesmo PR que extrai o módulo.
- `handleMarker` permanece duplicado (~120 linhas). Aceitável: é stateful, tem efeitos colaterais, e a assinatura da barbearia divergiu (campo `telefone` extra). Extrair `handleMarker` é uma decisão separada e mais arriscada — não faz parte desta proposta.

### Neutras
- O arquivo `vendas-utils.ts` não é um `package` de workspace — é um módulo interno de `apps/api`. Não exige `tsconfig.json` extra, não exige entrada em `package.json` de workspaces.

---

## Plano de migração

1. Criar `apps/api/src/bots/lib/vendas-utils.ts` com: `ParsedMarker` (interface), `ConversationState` (interface), `parseMarker`, `parseConversationState`, `formatPrice`, `formatCoursesForPrompt`, `formatMediaForPrompt`, `sanitizar`.
2. Em `teste_vendas.ts`: remover as 7 definições duplicadas, adicionar import de `vendas-utils.ts`. Renomear chamadas de `sanitizar` (já usa esse nome).
3. Em `teste_vendas_barbearia.ts`: mesmo procedimento. Renomear chamada de `sanitizarResposta` para `sanitizar` (compatível — mesma implementação).
4. `handleMarker` permanece em cada arquivo sem alteração.
5. Tester valida: smoke test em ambos os bots após merge, confirmando envio de mídia e formatação de cursos.

**Estimativa de linhas modificadas:** ~200 (remoção de ~170 por arquivo, criação de ~170 no utils). Abaixo do limiar de 300 linhas — mas este ADR já cobre a decisão. Implementação pode seguir sem novo ADR.

---

## Validação

- `grep -c "function parseMarker" apps/api/src/bots/` retorna `0` (função não duplicada nos bots).
- `grep -c "function parseMarker" apps/api/src/bots/lib/vendas-utils.ts` retorna `1`.
- Build `npm run build --workspaces` passa sem erros.
- Smoke test: mensagem com marcador `[VIDEO:<id>]` em `teste_vendas` e em `teste_vendas_barbearia` — ambos entregam mídia corretamente.
- Smoke test: mensagem que dispara `[LISTA_CURSOS]` — lista formatada idêntica nos dois bots.

---

## Rollback

- Reverter o PR que implementa a extração via `git revert`.
- Sem migration de banco, sem mudança de infraestrutura. Rollback em <5 minutos.

---

## Referências

- Missão 016: `docs/missoes/016-onda-3c-adr-vendas-mixin.md`
- `apps/api/src/bots/teste_vendas.ts` — funções em linhas 29-184
- `apps/api/src/bots/teste_vendas_barbearia.ts` — funções em linhas 31-117, 340-352
- Memória `project_arquitetura_fluxos` — modelo de isolamento de bots
- CLAUDE.md Regra de Ouro 7 — isolamento de bots
