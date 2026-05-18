# Missão 006 — Biblioteca de Vídeos Contextual + Catálogo de Cursos

**DRI:** dev-back (Fases 1–2), dev-front (Fase 3), tester (Fase 4)
**Agentes envolvidos:** dev-back, dev-front, tester, gerente-pr
**Apetite:** grande (4 fases, 4–6 PRs, ~5–8 dias)
**Status:** pendente
**Cliente (persona):** Lead que testa o bot `teste_vendas_barbearia` e espera receber vídeos no momento certo; Bruno/Ícaro que cadastram cursos e mídias via painel sem tocar no banco.
**Aberta em:** 2026-05-18
**PR-FAQ:** docs/missoes/PRFAQ-biblioteca-videos-contextual.md (branch principal)

---

## Contexto

O bot `teste_vendas_barbearia` envia todos os vídeos de curso em bloco (posições V1/V2/V3) toda vez que detecta interesse — sem saber qual curso o lead escolheu, sem separar vídeo de apresentação de vídeos secundários, e sem evitar reenvio. Mídias "livres" (sem vínculo a curso) ficam no mesmo balde de V1–V3, perdendo o potencial de envio contextual autônomo. Não existe tela no painel para cadastrar cursos nem vincular mídias — qualquer alteração exige SQL direto. A missão cria a estrutura (`bot_courses` + vínculos) e o comportamento novo (lista → escolha → vídeo único → contextual), e entrega a UI de gestão no painel.

---

## Solução proposta

- Nova tabela `bot_courses` (catálogo de cursos por slot, multi-tenant)
- Colunas `course_slug` e `is_course_intro` adicionadas em `bot_media`; seed popula os 5 vídeos existentes de `teste_vendas_barbearia` conforme mapeamento aprovado
- Clone factory (`painel-admin/server.js` linhas ~1844 e ~1995) passa a copiar `bot_courses` ao clonar uma matriz, preservando isolamento multi-tenant
- Novo endpoint CRUD `/api/bots/:slot/courses`; lógica de envio em `apps/api/src/bots/teste_vendas_barbearia.ts` e `teste_vendas.ts` refatorada para o fluxo de 5 etapas com marcadores de memória
- Tela "Cursos" no drawer do bot no painel: cadastrar/editar curso, vincular/desvincular mídia, promover vídeo de apresentação em 2 cliques

---

## Definition of Done

**Fase 1 — DB + seed**
- [ ] Migration `019_bot_courses.sql` cria `bot_courses` com campos: `id, slot, course_slug, name, description, price, duration, position_order, enabled` + constraint `UNIQUE(slot, course_slug)`
- [ ] Migration `019_bot_courses.sql` adiciona `course_slug TEXT REFERENCES bot_courses(course_slug)` e `is_course_intro BOOLEAN DEFAULT false` em `bot_media`
- [ ] Seed dentro da mesma migration insere 2 cursos em `bot_courses` para `teste_vendas_barbearia`: `curso-online-degrade` e `curso-presencial-barbearia`
- [ ] Seed atualiza os 5 vídeos de `teste_vendas_barbearia` conforme tabela de mapeamento: `online_degrade_apresentacao` (intro de `curso-online-degrade`), `presencial_alunos_formados` (intro de `curso-presencial-barbearia`), `presencial_alunos_cortando` (secundário de `curso-presencial-barbearia`), `demo_corte_degrade_1` e `demo_corte_degrade_2` (sem `course_slug`, livres)
- [ ] Clone factory copia linhas de `bot_courses` ao clonar uma matriz (dentro de `createClone()` em `packages/db/src/queries/flow-clones.ts` e no handler do painel em `painel-admin/server.js` ~1844 e ~1995)
- [ ] Migration é idempotente (BEGIN/COMMIT, IF NOT EXISTS, ON CONFLICT)
- [ ] `npm run build --workspaces` passa sem erro

**Fase 2 — API + lógica do bot**
- [ ] `GET /api/bots/:slot/courses` retorna lista ordenada de cursos do slot
- [ ] `POST /api/bots/:slot/courses` cria curso; valida campos obrigatórios (`course_slug`, `name`)
- [ ] `PUT /api/bots/:slot/courses/:course_slug` atualiza curso
- [ ] `DELETE /api/bots/:slot/courses/:course_slug` desativa (`enabled = false`), não deleta
- [ ] `PUT /api/bots/:slot/courses/:course_slug/intro/:media_id` promove uma mídia como `is_course_intro = true` e rebaixa as demais do mesmo curso
- [ ] Lógica de `teste_vendas_barbearia.ts` implementa o fluxo de 5 etapas: (1) interesse genérico → lista textual de cursos; (2) escolha de curso → envia só o vídeo `is_course_intro = true`; (3) pergunta contextual → IA decide via marcador `[VIDEO:<media_id>]` no fim da resposta; (4) "manda tudo" → envia todos os vídeos do curso; (5) "manda o de X" → best-match por `context`
- [ ] Marcador `COURSE_VIDEO_MARKER` substituído por rastreamento por `media_id` em memória conversacional (não reenvia espontaneamente o que já foi enviado)
- [ ] `teste_vendas.ts` recebe o mesmo tratamento de lógica (sem catálogo de barbearia, só fluxo de cursos)
- [ ] Prompt de `teste_vendas_barbearia` atualizado: remove instruções de `[V1]` hardcoded, substitui por seção `[CURSOS DISPONÍVEIS]` populada dinamicamente de `bot_courses`
- [ ] `npm run build --workspaces` passa

**Fase 3 — Painel UI**
- [ ] Drawer do bot exibe aba "Cursos" (ao lado de "Mídias" existente)
- [ ] Aba lista cursos do slot com: nome, preço, duração, número de vídeos vinculados, status (ativo/inativo)
- [ ] Formulário inline cria/edita curso (nome, slug, descrição, preço, duração, order, enabled)
- [ ] Cada curso exibe vídeos vinculados; botão "Definir como apresentação" promove o vídeo em 1 clique (chama `PUT .../intro/:media_id`)
- [ ] Vincular mídia existente a um curso: dropdown com mídias livres do slot
- [ ] Desvincular mídia de curso: botão na linha da mídia, confirma com 1 clique
- [ ] UX: identidade visual coerente com o painel existente (sem Bootstrap genérico; seguir padrão das outras abas do drawer)

**Fase 4 — QA + deploy**
- [ ] Tester executa smoke test no bot `teste_vendas_barbearia`: (a) lead diz "quero saber dos cursos" → recebe lista textual; (b) lead diz "quero o presencial" → recebe 1 vídeo (intro); (c) lead pergunta sobre alunos → IA envia vídeo contextual se `context` casa; (d) lead diz "manda tudo" → recebe todos os vídeos do curso presencial; (e) bot não reenvia vídeo já enviado
- [ ] Tester valida zero regressão em `teste_barbearia`: fluxo de agenda funciona, sem erro de colunas novas
- [ ] `teste_vendas` envia vídeo de apresentação corretamente ao detectar interesse no curso
- [ ] Clone criado a partir de `teste_vendas_barbearia` herda os 2 cursos e os 5 vídeos vinculados
- [ ] Painel cadastra novo curso em `teste_vendas_barbearia` sem SQL manual
- [ ] Build local passa (`npm run build --workspaces`)
- [ ] Tester rodou checklist completo (conteúdo acima) e assinou APROVADO PARA PR
- [ ] PR mergeada pelo Bruno
- [ ] Deploy validado em produção (`curl -u admin:startap2026 https://gestao.startap.tech/api/bots/teste_vendas_barbearia/courses` retorna os 2 cursos)

---

## Fora de escopo

- Self-service do cliente final para cadastrar seus próprios cursos (sem login do cliente neste repo)
- Upload de vídeo direto pelo painel (Missão 004 cuida do pipeline de mídia)
- Cursos para bots de barbearia pura (`teste_barbearia`) — sem cursos no fluxo de agenda
- Internacionalização ou multi-idioma dos nomes de cursos
- Histórico/auditoria de alterações em `bot_courses`
- Recomendação automática de curso por perfil do lead (IA decide por `context`, não por scoring)
- Rollback automático de seed caso migration falhe parcialmente (DBA reverte manualmente)

---

## Dependências

- Missão 003 encerrada — `createClone()` e `setCloneSession()` em produção (necessário para a Fase 1 replicar cursos no clone factory)
- Missão 004 (upload de vídeo) não é pré-requisito — vídeos já existem em `bot_media` com URL preenchida; Fase 2 lê o que já está no banco
- Migration 018 (`gcal_credentials`) ser a última migration aplicada em produção — nova migration será `019`

---

## Riscos

- **Migration altera `bot_media` que já tem ~20 linhas em prod:** `ADD COLUMN IF NOT EXISTS` é não-destrutivo; seed usa `ON CONFLICT ... DO UPDATE` — baixo risco; dev-back testa em staging antes do PR
- **Clone factory em `painel-admin/server.js` tem dois pontos de cópia de `bot_media` (~1844 e ~1995):** se um dos dois não copiar `bot_courses`, clone fica sem cursos; dev-back deve grep ambos os pontos antes de fechar Fase 1
- **Lógica de "best-match por context" em Fase 2 pode produzir envios errados (IA envia vídeo de barbearia quando lead pergunta sobre curso):** mitigação — `context` de mídias livres deve ser explicitamente sobre barbearia (ex: "demonstração de degradê"); prompt atualizado instrui IA a só usar `[VIDEO:<id>]` quando `context` bater semanticamente com a pergunta
- **Refatorar `sendCourseVideosInstance` quebra `teste_vendas.ts` se os dois bots compartilharem lógica via herança:** `teste_vendas.ts` tem sua própria implementação; dev-back isola a refatoração por arquivo, tester valida ambos separadamente
- **Memória conversacional de rastreamento de vídeos enviados cresce com uso intenso:** implementar rastreamento como lista em memória da sessão (não tabela nova); aceita-se que ao limpar memória, o bot pode reenviar — comportamento esperado

---

## Plano de quebra (apetite = grande)

| Sub-missão | Slug | DRI | Descrição resumida |
|---|---|---|---|
| **006-A** | db-seed-cursos | dev-back | Migration `019_bot_courses.sql` + seed dos 5 vídeos + replicação no clone factory |
| **006-B** | api-logica-bot | dev-back | Endpoint CRUD `/api/bots/:slot/courses` + refatoração da lógica dos bots (`teste_vendas_barbearia.ts`, `teste_vendas.ts`) + prompt atualizado |
| **006-C** | painel-ui-cursos | dev-front | Aba "Cursos" no drawer do bot: lista, formulário, vínculo de mídia, promoção de intro |
| **006-D** | qa-deploy | tester + gerente-pr | Smoke test completo (5 cenários), validação de zero regressão, PR final, deploy |

**Sequência obrigatória:** 006-A → 006-B → 006-C → 006-D. As PRs de 006-B e 006-C podem abrir em paralelo após 006-A mergeada.

---

## Atualizações (log)

- 2026-05-18: Aberta pelo `product-owner` após Bruno aprovar PR-FAQ com todas as decisões fechadas.
