# PR-FAQ + Missão 001 — Isolamento de Memória entre Clones

> **Escrito por:** `product-owner`
> **Data:** 2026-05-17
> **Status do PR-FAQ:** aguardando aprovacao do Bruno

---

## PR-FAQ: Isolamento de Memória e Identidade por Clone de Bot

### Press Release

**Hoje, 2026-05-17, a Startap lança o isolamento completo de memória e identidade por clone — garantindo que cada cliente tenha um bot 100% seu, sem contaminação de dados de outros clientes.**

Antes, quando um clone era criado a partir de uma matriz (ex: `teste_barbearia`), a memória de conversa era gravada com o `projectId` fixo da matriz. Isso significava que dois clones da mesma matriz compartilhavam a mesma chave de sessão no banco e, em cenários com a mesma sessão WAHA, poderiam "ler" o histórico um do outro. Agora, cada clone tem seu `projectId` e sua `memoryTable` derivados do seu próprio `slot`, garantindo isolamento total.

Henrique, dono da Barbearia Estilo Certo e primeiro cliente a clonar o bot de barbearia, diz: "Eu queria ter certeza de que meus clientes não iam receber respostas misturadas com o que outros barbeiros configuraram. Agora sei que o bot é meu de verdade — ele só conhece o meu negócio."

A correção já está disponível em produção para todos os clones ativos e novos clones criados pelo painel a partir desta data.

---

### FAQ Interna

**Q: Quem se beneficia diretamente?**
A: Clientes que contratam um clone dedicado (barbearia ou vendas de curso). No estágio atual, o Bruno e o Ícaro se beneficiam indiretamente porque evitam incidentes de suporte causados por contexto cruzado entre clientes.

**Q: Por que estamos fazendo isso agora?**
A: O arquiteto levantou como P1 antes do primeiro clone de cliente entrar em producao paga. O risco identificado é concreto: a linha `base.ts:196` usa `cfg.projectId` fixo (sempre o slot da matriz) na chave de memoria, e `memoryTable` é hardcoded na classe do bot. Se dois clones da mesma matriz recebem mensagens de clientes diferentes com a mesma sessao WAHA (cenário possível durante migração), os contextos colidem.

**Q: Qual o risco de NÃO fazer?**
A: Vazamento de contexto entre clientes pagantes. Cenário concreto: cliente A da Barbearia X agenda um corte; cliente B do clone Y (mesma matriz) recebe uma resposta contendo informações do cliente A porque o histório foi carregado pelo session_id errado. Isso gera churn imediato, risco de LGPD e dano de reputação.

**Q: Quais alternativas foram consideradas?**
A:
1. **Tabela separada por clone** (ex: `chat_histories_clone_xyz`): isolamento físico máximo, mas gera proliferação de tabelas — descartado.
2. **Prefixo de projectId na chave de sessão** (solução escolhida): mantém tabela compartilhada, usa `slotOverride` como `projectId` efetivo na chave. Custo zero de schema.
3. **Coluna `slot` na tabela de memoria com filtro**: similar à opção 2 mas exige migration. Pode ser fase 2 se escala exigir.

**Q: O que NÃO está incluso nesta missão?**
A: Migração retroativa de histórico de clones já ativos (se houver dados, ficam na chave antiga — não são apagados, apenas "abandonados" por chave nova). Dashboard de consumo de memória por clone. Qualquer mudança no schema de `chat_histories`. Landing page ou captação de clientes (fora de escopo per política da empresa).

**Q: Como medimos sucesso?**
A:
- Em 7 dias após deploy: zero registros de `flow_execution_logs` com `eventType=bot.memory-human` e mesmo `sessionHash` para telefones distintos em clones diferentes da mesma matriz.
- Teste manual: enviar mensagem para clone A e clone B (mesma matriz, sessões WAHA distintas) e confirmar que o histórico carregado em cada um não contém entradas do outro.

**Q: Qual o apetite?**
A: Médio — 2 a 4 PRs, estimativa Shape Up de 1-2 semanas.

**Q: Quem é o DRI?**
A: `arquiteto` (design da solução — ADR obrigatório antes de codar). `dev-back` é o executor principal.

**Q: Quais agentes envolvidos?**
A: `arquiteto` (ADR), `dev-back` (implementação), `tester` (validação), `gerente-pr` (PR e release).

**Q: Riscos principais?**
A:
1. **Clones criados antes da correção** ficam com chave de memoria antiga: mitigação — manter chave legada como fallback de leitura na primeira mensagem, depois migrar para nova chave.
2. **memoryTable hardcoded por bot** pode persistir se o dev-back não perceber que a tabela também precisa ser derivada do clone: mitigação — ADR deve especificar explicitamente qual campo muda.
3. **Regressão nas matrizes de teste** (teste_barbearia etc.) que não usam slotOverride: mitigação — tester deve rodar smoke test nas matrizes ANTES de validar clones.

**Q: Dependências?**
A: Nenhuma missão anterior bloqueante. Depende apenas de que o ADR seja escrito e aprovado pelo Bruno antes de qualquer PR de codigo.

---

### FAQ Externa (o que muda para o cliente)

**Q: O bot do meu negócio vai parar de funcionar durante a atualização?**
A: Não. A mudança é transparente. As mensagens continuam sendo processadas normalmente. O histórico de conversas anteriores pode não ser carregado nas primeiras mensagens após o deploy — é como começar uma conversa nova. As conversas novas ficam 100% isoladas.

**Q: Meu bot vai "esquecer" o histórico dos meus clientes?**
A: O histórico existente não é apagado do banco. Ele fica preservado. Dependendo de como o arquiteto desenhar a migração (ver Fase 2 opcional), pode ser reindexado. Na pior hipótese, conversas antigas ficam fora da janela de contexto — o bot começa a "janela deslizante" do zero para cada número.

**Q: Isso resolve o risco de o meu bot responder com informações de outro cliente?**
A: Sim. Essa é a razão principal da missão. Após o deploy, cada bot clone opera em isolamento total de memória em relação a outros clones da mesma base.

---

### Decisao do Bruno

- [ ] Aprovado — `product-owner` cria missão formal (seção abaixo ja pronta)
- [ ] Aprovado com mudancas: _______________
- [ ] Adiar — motivo: _______________
- [ ] Recusar — motivo: _______________

---

---

# Missão 001 — Isolamento de Memória entre Clones

**DRI:** `arquiteto` (design) + `dev-back` (implementacao)
**Agentes envolvidos:** `arquiteto`, `dev-back`, `tester`, `gerente-pr`
**Apetite:** médio (Shape Up — 1-2 semanas, máx 4 PRs)
**Status:** pendente (aguardando aprovacao do Bruno no PR-FAQ acima)
**Cliente (persona):** clientes pagantes com clone dedicado de bot (primeiro: barbeiros)
**Aberta em:** 2026-05-17
**PR-FAQ:** este mesmo arquivo, seção acima

---

## Contexto

Quando um clone é instanciado a partir de uma matriz (ex: `TesteBarbeariaBot` com `slotOverride`), o campo `cfg.projectId` permanece fixo com o slot da matriz (`teste_barbearia`), não o slot do clone. A chave de memória gerada em `base.ts:196` é `{projectId}:{sessao}:{flowId}:{telefone}` — usando o projectId errado. Adicionalmente, `memoryTable` é hardcoded por classe de bot, compartilhada entre todos os clones dessa matriz. O resultado é risco real de vazamento de contexto entre clientes de clones distintos que compartilhem sessão WAHA ou telefone em momentos de migração.

## Solução proposta

- Fazer `projectId` efetivo de um clone ser derivado do `slotOverride`, não do slot da matriz — alinhando-o com o `slot` ja usado para leitura de `bot_config`/`bot_prompt`
- Garantir que `memoryTable` também seja escoped por clone (estratégia a ser definida no ADR: prefixo vs. tabela dedicada vs. coluna discriminadora)
- Atualizar a fábrica de clones em `router.ts` (função `resolveCloneBot`) para passar os parâmetros corretos de isolamento ao instanciar o bot
- Escrever ADR documentando a decisão de isolamento antes de qualquer PR de codigo
- Validar que as matrizes de teste (`teste_barbearia`, `teste_vendas`, `teste_vendas_barbearia`) e Lola (`startap`) não são afetadas (não usam `slotOverride`)

## Definition of Done (DoD)

- [ ] ADR escrito pelo `arquiteto` e aprovado pelo Bruno antes do primeiro commit de código
- [ ] `memorySessionId` em `base.ts:196` usa o `slotOverride` (ou equivalente derivado) como `projectId` quando o clone está ativo
- [ ] `memoryTable` de um clone é isolada da `memoryTable` da matriz de origem (via estratégia do ADR)
- [ ] Smoke test manual: mensagem enviada ao clone A e ao clone B (mesma matriz, sessões WAHA diferentes) — os históricos carregados são distintos e não se cruzam
- [ ] Smoke test de regressão: matrizes `teste_barbearia`, `teste_vendas`, `teste_vendas_barbearia` e `startap` respondem normalmente sem alteração de comportamento
- [ ] Build local passa (`npm run build --workspaces`)
- [ ] Tester rodou checklist completo e registrou resultado (`APROVADO PARA PR`)
- [ ] PR mergeada pelo Bruno
- [ ] Deploy validado em producao (`curl` no endpoint de health retorna 200, nenhum erro novo em logs de execução)

## Fora de escopo

- Migração retroativa de histórico existente em clones que ja estejam ativos (fase 2 opcional se houver demanda)
- Dashboard de consumo de memória por clone
- Mudanca de schema da tabela `chat_histories` (preservar compatibilidade)
- Criação de landing page ou fluxo de captacao de clientes
- Qualquer alteração nos bots das matrizes de teste (`teste_barbearia`, `teste_vendas`, `teste_vendas_barbearia`) além do necessário para suportar a mudança no `BotBase`

## Dependências

- Nenhuma missão bloqueante anterior
- ADR (a ser escrito pelo `arquiteto`) deve ser aprovado pelo Bruno antes da PR de código
- Acesso a pelo menos um clone de teste ativo em staging para validação end-to-end

## Riscos

- **Clones criados antes do deploy ficam com chave de memória legada:** mitigação — `arquiteto` decide no ADR se implementa fallback de leitura na chave antiga na primeira mensagem ou se aceita "reset" de contexto como comportamento esperado.
- **Regressão nas matrizes de teste (sem slotOverride):** mitigação — tester executa smoke test nas matrizes ANTES de validar clones; qualquer falha bloqueia o merge.
- **memoryTable hardcoded na subclasse pode ser esquecida pelo dev-back:** mitigação — ADR deve listar explicitamente cada ponto de mudança em `base.ts` e nas subclasses; `arquiteto` revisa PR antes do Bruno.

## Plano de quebra (apetite médio — máx 4 PRs)

1. **001-A: ADR de isolamento** — `arquiteto` escreve `docs/adr/XXX-isolamento-memoria-clones.md` com a decisão técnica. Sem código. Bruno aprova antes de 001-B começar.
2. **001-B: Correção de projectId e memoryTable em BotBase** — `dev-back` implementa a mudança central. Inclui testes unitários de `memorySessionId`.
3. **001-C: Atualização da factory de clones em router.ts** — `dev-back` garante que `resolveCloneBot` passa os parâmetros corretos. Pode ser parte de 001-B se o impacto for pequeno.
4. **001-D: Validação e PR final** — `tester` executa checklist completo. `gerente-pr` consolida e abre PR para revisão do Bruno.

## Atualizações (log)

- **2026-05-17:** Aberta pelo `product-owner`. PR-FAQ embutido. Aguardando aprovacao do Bruno.
