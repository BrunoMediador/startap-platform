# Missão 013 — Onda 2: Exatidão de dados no painel (B1-B9)

**DRI:** dev-back (B1-B4, B9) + dev-front (B5-B8)
**Agentes envolvidos:** dev-back, dev-front, tester, gerente-pr
**Apetite:** grande (até 5 dias úteis, ~1 semana)
**Status:** bloqueada
**Cliente (persona):** Bruno e Ícaro — os dados errados no painel levam a decisões erradas de venda e operação
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (bugs de dados e exibição, não features)

---

## Contexto

A auditoria de 2026-05-19 identificou 9 achados de exatidão que tornam o painel não confiável: métricas de leads infladas (B1), gráfico de mensagens contando status errado (B2), custo de token com preço incorreto (B3), execuções "running" nunca fechadas (B4), gráficos com timezone errado (B5), ícones ausentes quebrando a UI (B6), erros silenciosos escondendo falhas (B7), tabela de leads truncando sem aviso (B8) e fallback de modelo desatualizado (B9). Esses bugs são independentes entre si e cada um cabe em uma PR pequena. A missão começa assim que o achado A1 da Missão 012 for mergeado (branch desbloqueada).

## Restrições críticas

- Cada item é uma PR separada e independente — não agrupar vários em uma PR para facilitar review
- Mudança em query SQL: sempre verificar se o campo retornado é consumido pelo frontend (`painel-admin/public/index.html`) antes de alterar o shape
- Sem mudanças de schema do banco nessa onda (só queries e código)

## Sub-missões / PRs

### PR-B1 — Corrigir `leads_count` por slot em `/api/bots` (dev-back)
**Achado:** `server.js:597` — `leads_count` soma leads de todos os slots, não só do bot em questão.
**Escopo:** adicionar `WHERE slot = $1` (ou equivalente com `ANY($slots)`) na subquery de contagem; confirmar com `curl /api/bots` que cada bot retorna count isolado.

### PR-B2 — Corrigir timeseries "mensagens por dia" (dev-back)
**Achado:** `server.js:2058, 2169` — série temporal conta `session.status` em vez de eventos de mensagem reais.
**Escopo:** corrigir a query para filtrar apenas `event_type IN ('webhook.received', 'bot.reply-sent')` ou equivalente já estabelecido na codebase; validar que totais batem com `/api/message-stats`.

### PR-B3 — Corrigir custo `gpt-5.4` hardcoded (dev-back)
**Achado:** `packages/db/src/queries/model-usage.ts:27` — pricing de `gpt-5.4` com valor incorreto/estimado.
**Escopo:** atualizar constante com o preço correto documentado pela OpenAI; adicionar comentário com fonte e data de verificação; registrar em `docs/missoes/018` item D11 que esse campo precisa de revisão periódica.
**Restrição:** se OpenAI ainda não publicou preço oficial de `gpt-5.4`, usar o melhor valor disponível e documentar como estimado.

### PR-B4 — Invocar `closeStaleRunning` no startup (dev-back)
**Achado:** `packages/db/src/queries/flow-execution-log.ts:137` — função existe mas nunca é chamada; execuções "running" de antes de um restart ficam presas para sempre.
**Escopo:** chamar `closeStaleRunning()` no startup da API (ou do worker, onde fizer mais sentido arquiteturalmente); adicionar log de quantas execuções foram fechadas.

### PR-B5 — Timezone nos gráficos de barras e GCal (dev-front)
**Achado:** `index.html:4725` (eixo X do gráfico de barras) e `index.html:5966` (Google Calendar) — `Date()` sem `timeZone: 'America/Sao_Paulo'`.
**Escopo:** adicionar `timeZone: 'America/Sao_Paulo'` em todos os `toLocaleString` e `toLocaleDateString` dos gráficos; corrigir função `fmtDate()` (linha 1815) para forçar timezone; validar que datas batem com horário BRT.

### PR-B6 — Adicionar 12 ícones SVG ausentes no painel (dev-front)
**Achado:** auditoria frontend 2026-05-18 identificou as seguintes chaves ausentes no objeto `ICONS`: `power`, `more-horizontal`, `edit-2`, `external-link`, `x-circle`, `save`, `chevron-left` (botão "Voltar" do wizard usa `chevron-right` erroneamente).
**Escopo:** adicionar os SVGs inline correspondentes no objeto `ICONS`; corrigir `chevron-right` nos botões "Voltar" dos steps 2, 3 e 4 do wizard para `chevron-left`.
**Restrição:** usar SVGs do mesmo family já adotado no painel (Lucide); não introduzir nova biblioteca de ícones.

### PR-B7 — Expor erros em SSE, filtros e bulk delete (dev-front)
**Achado:** `index.html:4601` (SSE), `4658` (filtros), `6971` (bulk delete) — `catch (_) {}` silencioso esconde falhas.
**Escopo:** substituir catches silenciosos por `console.error` + toast de erro visível ao usuário; para SSE, exibir indicador de "conexão perdida" com botão de reconexão.

### PR-B8 — Aviso de truncamento em `renderLeadsStub` (dev-front)
**Achado:** `index.html:2724` — `leads.slice(0, 20)` sem aviso; usuário com 50 leads pensa que só tem 20.
**Escopo:** exibir banner/nota abaixo da tabela quando `leads.length > 20`: "Exibindo 20 de N registros. Use o filtro para refinar." Não é paginação completa — só aviso informativo.

### PR-B9 — Corrigir fallback de modelo em `apps/api/src/config.ts` (dev-back)
**Achado:** `apps/api/src/config.ts:20` — fallback ainda é `gpt-4o-mini`; Bruno definiu `gpt-5.4` como padrão em 2026-05-18 (memória `project_modelo_padrao_bots`).
**Escopo:** atualizar constante de fallback para `gpt-5.4`; confirmar com tester que bots em prod continuam usando `gpt-5.4` após deploy.

## Definition of Done (DoD)

- [ ] B1: `GET /api/bots` retorna `leads_count` corretamente isolado por slot (verificado com `curl`)
- [ ] B2: gráfico "mensagens por dia" bate com total de `/api/message-stats` no mesmo período
- [ ] B3: `packages/db` contém custo de `gpt-5.4` atualizado com comentário de fonte
- [ ] B4: log de startup mostra "X execuções stale fechadas" (mesmo que X=0)
- [ ] B5: gráfico de barras exibe datas em BRT; teste: mensagem às 22h BRT aparece no dia correto
- [ ] B6: nenhum botão do painel exibe área vazia onde deveria haver ícone; wizard mostra `chevron-left` nos "Voltar"
- [ ] B7: erro de SSE exibe toast + botão de reconexão; bulk delete informa qual telefone falhou
- [ ] B8: tabela de leads com mais de 20 registros exibe aviso de truncamento
- [ ] B9: `config.ts` contém `DEFAULT_MODEL = 'gpt-5.4'`
- [ ] Build local passa (`npm run build --workspaces`) após cada PR
- [ ] Tester rodou checklist em cada PR antes de abrir para review
- [ ] Cada PR mergeada individualmente pelo Bruno
- [ ] Deploy validado em produção após cada merge

## Fora de escopo

- Paginação completa de leads (B8 é só aviso — paginação real é missão separada)
- Redesign visual do painel
- Mudanças de schema do banco
- Criptografia de credenciais (Missão 012)
- Correção de timezone no servidor Postgres (depende de configuração de infra)

## Dependências

- **Missão 012 PR-A1** mergeada — branch desbloqueada antes de qualquer PR desta onda
- B5 timezone: confirmar com infra se o servidor Postgres está configurado como UTC (para entender se a correção é só no JS ou também precisa de `AT TIME ZONE` nas queries da Onda 2) — se precisar de `AT TIME ZONE` nas queries, verificar com dev-back

## Riscos

- **B3 — preço gpt-5.4 não publicado pela OpenAI:** mitigação: documentar como estimado e criar item D11 na Missão 018 para revisão
- **B4 — closeStaleRunning em prod fecha execuções que ainda estão rodando:** mitigação: verificar se há execuções genuinamente running antes do deploy; executar em horário de baixo tráfego
- **B6 — SVG inline aumenta tamanho do HTML:** mitigação: todos os ícones já são inline no painel; padrão já estabelecido, adição de 12 SVGs é marginal

## Plano de quebra

1. **013-B1:** leads_count por slot — dev-back
2. **013-B2:** timeseries mensagens — dev-back
3. **013-B3:** custo gpt-5.4 — dev-back
4. **013-B4:** closeStaleRunning — dev-back
5. **013-B9:** fallback modelo — dev-back
6. **013-B5:** timezone gráficos — dev-front
7. **013-B6:** ícones ausentes — dev-front
8. **013-B7:** catches silenciosos — dev-front
9. **013-B8:** aviso truncamento leads — dev-front

B1-B4 e B9 podem ser paralelos entre si (dev-back). B5-B8 podem ser paralelos entre si (dev-front). As duas trilhas são independentes.

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria de 2026-05-19; bloqueada até Missão 012 PR-A1 mergear
