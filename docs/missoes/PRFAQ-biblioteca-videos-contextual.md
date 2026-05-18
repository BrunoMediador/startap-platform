# PR-FAQ: Biblioteca de Videos Contextual com Multiplos Cursos

> **Quem escreve:** `product-owner`
> **Quando:** antes de qualquer codigo ser escrito pra essa feature
> **Inspiracao:** Amazon Working Backwards — imaginar o release antes de comecar

---

## Press Release (imagina o anuncio do dia que isso lancar)

**Hoje, 2026-05-18, a Startap lanca a Biblioteca de Videos Contextual — uma forma de o bot entender qual curso o lead quer conhecer e mandar o video certo na hora certa, sem desperdicio e sem mandar tudo de uma vez.**

Antes, o bot mandava uma sequencia fixa de videos (V1/V2/V3) na primeira mensagem, independente do que o lead perguntou — ou, pior, nao mandava nada porque a posicao estava vazia. Agora, o bot apresenta o catalogo de cursos quando o lead demonstra interesse generico, envia o video de apresentacao do curso que o lead escolheu, e continua encaixando videos relevantes ao longo da conversa conforme o contexto pede.

Bruno diz: "Antes o bot mandava tres videos de uma vez logo de cara — muita coisa pra quem ainda nem sabia o que queria. Agora ele entende o momento do lead e manda o video certo. Vendo mais com menos atrito."

A funcionalidade estara disponivel no bot `teste_vendas_barbearia` e no `teste_vendas` a partir do deploy, com painel atualizado para cadastrar cursos e vincular midias.

---

## FAQ

**Q: Quem se beneficia diretamente?**
A: Tres personas distintas:
1. **Lead novo no WhatsApp** — recebe informacao progressiva e personalizada ao inves de um bombardeio de videos que nao pediu.
2. **Bruno e Icaro (time de vendas)** — taxa de engajamento maior porque o lead chegou mais aquecido ao momento de inscricao.
3. **Clientes donos do bot** (ex: cliente que contratou o combo barbearia+curso) — bot mais inteligente sem precisar reconfigurar nada manualmente.

**Q: Por que estamos fazendo isso agora?**
A: O bot `teste_vendas_barbearia` esta sem enviar videos em producao (modelo V1/V2/V3 quebrado). Em vez de aplicar um fix tampao que perpetua a logica rigida, Bruno aprovou ir direto para a solucao definitiva. Alem disso, a Startap ja tem mais de um curso disponivel — a logica de "manda tudo na primeira mensagem" nunca vai funcionar para multiplos cursos.

**Q: Como funciona pro lead (passo a passo)?**
A:
1. Lead manda mensagem sobre curso (qualquer curso, interesse generico).
2. Bot responde com uma **lista de cursos disponivel** em texto — ex: "Temos o Curso de Barbeiro Profissional e o Curso de Coloracao. Qual te interessa mais?"
3. Lead escolhe um curso especifico.
4. Bot responde sobre aquele curso E envia o **video de apresentacao** daquele curso.
5. Durante a conversa, quando o lead pergunta algo com video relacionado (ex: "tem diploma?", "como e a aula presencial?"), o bot responde em texto E envia o video especifico desse topico se houver um disponivel na biblioteca.
6. Se o lead pedir explicitamente ("me manda os videos todos", "manda o de degrade"), o bot atende o pedido — 1 especifico ou todos da biblioteca do curso que ele escolheu.

**Q: Como a IA detecta o que o lead quer?**
A: A IA recebe no system prompt um catalogo de midias com descricoes contextuais (ja existe na tabela `bot_media.context`). Quando a resposta da IA inclui um marcador do tipo `[VIDEO:id-do-video]`, o sistema intercepta antes de enviar ao WhatsApp, busca a midia por ID/slug e envia. A IA nao inventa IDs — ela so usa IDs que estao no catalogo injetado no prompt. Quatro intents mapeados:

- **Interesse generico em curso** → IA responde com lista de cursos (texto). Sem video ainda.
- **Escolha de curso especifico** → IA responde sobre aquele curso + coloca `[VIDEO:slug-do-curso-apresentacao]`.
- **Pergunta contextual com video relacionado** → IA responde normalmente + pode incluir `[VIDEO:slug-relevante]` se o contexto bater.
- **Pedido explicito de video** → IA responde + inclui `[VIDEO:slug]` (especifico) ou `[VIDEO:TODOS_CURSO:slug-do-curso]` (todos do curso escolhido).

**Q: O catalogo de cursos precisa de tabela nova ou vive nas midias?**
A: **Decisao em aberto para o Bruno** — ver Pergunta-Chave #1 abaixo. As duas opcoes sao:
- **Opcao A (simples):** Cursos vivem como agrupamento das midias. Cada midia tem um campo `curso_slug` (novo campo em `bot_media`). A IA conhece os cursos pelo conjunto de midias que pertencem a cada slug. Sem tabela nova.
- **Opcao B (estruturada):** Tabela `bot_courses` separada (nome, descricao, slug, preco, duracao). Midias ficam vinculadas por `course_id`. Painel ganha tela de "Cursos" separada de "Midias".

**Q: O que persiste em memoria conversacional?**
A: A memoria ja existe via Postgres (`chat_histories_*`). O bot precisa registrar:
- Qual curso o lead escolheu (para nao perguntar de novo).
- Quais IDs de video ja foram enviados nessa conversa (para nao repetir).
Isso sera gravado como mensagens de sistema na memoria existente — mesmo padrao do `COURSE_VIDEO_MARKER` atual, sem nova infraestrutura.

**Q: O que NÃO esta incluso (escopo cortado)?**
A:
- Sem analytics de qual video foi mais assistido (medimos por envio, nao por visualizacao).
- Sem suporte a audio ou imagem na biblioteca contextual nessa fase — so video e texto.
- Sem "playlist automatica" ou sequencia forcada de videos — o lead so recebe o que a conversa pedir.
- Sem mudanca no fluxo de barbearia — agendamento continua igual.
- Sem self-service do cliente para configurar cursos — o painel (Bruno/Icaro) administra.
- O bot `teste_barbearia` (sem modulo de curso) nao e afetado.

**Q: Como medimos sucesso?**
A: Em 7-14 dias apos o deploy:
1. Taxa de videos enviados / conversas iniciadas sobre curso >= 60% (hoje: 0%, bot nao envia nada).
2. Taxa de leads salvos (`salvar_lead`) por semana — se subir, o engajamento melhorou.
3. Nenhum report de "bot mandou video errado" ou "bot mandou todos os videos sem pedir" de Bruno/Icaro.

**Q: Qual o apetite?**
A: **Grande** — precisa quebrar em fases. Sugestao de quebra:
- **006-A (medio):** Migrar logica de envio de V1/V2/V3 para `[VIDEO:slug]` no `teste_vendas_barbearia` com os 5 videos ja cadastrados migrados para o novo modelo. Sem catálogo de cursos ainda — um curso so ("Barbeiro Profissional"). Valida o mecanismo de marcador + envio contextual.
- **006-B (medio):** Adicionar conceito de curso (Opcao A ou B — Bruno decide). Painel atualizado. Fluxo de "lista de cursos → escolha → video de apresentacao" funcionando.
- **006-C (pequeno):** Migrar `teste_vendas` para o mesmo modelo. Smoke test de regressao em ambos os bots.

**Q: Quem e o DRI?**
A: `dev-back` — o nucleo e logica de prompt + interceptacao de marcador no backend. `dev-front` envolve apenas se a Opcao B (tabela de cursos) for escolhida e exigir tela nova no painel.

**Q: Quais agentes envolvidos?**
A: `arquiteto` (ADR antes de 006-A — envolve mudanca de schema se Opcao B), `dev-back` (DRI), `dev-front` (se painel precisar de tela nova), `tester` (regressao em ambos os bots), `gerente-pr` (PRs de cada fase).

**Q: Riscos principais?**
A:
1. **IA alucina IDs de video:** A IA pode inventar um slug que nao existe na biblioteca. Mitigacao: o interceptador ignora `[VIDEO:id-inexistente]` silenciosamente e loga como warning — o lead recebe a resposta em texto sem o video, sem crashar.
2. **Memoria de "curso escolhido" se perde entre sessoes:** Se o lead sair e voltar dias depois, o bot nao vai lembrar qual curso ele escolheu. Mitigacao: o bot pergunta de novo gentilmente. Nao e regressao — e comportamento esperado ja que a memoria tem janela limitada.
3. **Migracão dos 5 videos existentes quebra o slot atual:** Os videos `demo_corte_degrade_1` etc estao cadastrados com `position = 'V1'/'V2'/'V3'`. A migracao para slugs precisa ser feita com cuidado para nao perder dados. Mitigacao: fase 006-A faz a migracao com script de conversao antes de alterar o codigo — rollback possivel.
4. **teste_vendas e teste_vendas_barbearia divergem temporariamente:** Durante 006-A e 006-B, o `teste_vendas` ainda vai usar a logica antiga. Mitigacao: aceitavel, pois o Bruno aprovou. Fase 006-C re-sincroniza.

**Q: Dependencias?**
A: Missao 005 (clone WAHA automatico) nao e pre-requisito. Porem, a logica de herdar biblioteca da matriz para clones (painel-admin/server.js linhas 1844 e 1995) ja existe — o novo modelo precisa ser compativel com essa heranca para que clones futuros herdem as midias com os novos campos corretamente.

**Q: O que acontece se NAO fizermos?**
A: O bot `teste_vendas_barbearia` continua sem enviar nenhum video em producao. Leads que testam o bot combinado tem uma experiencia incompleta. Bruno e Icaro nao conseguem demonstrar o diferencial do produto (funil de video) para potenciais clientes que testam o bot. Cada semana sem isso e um argumento de venda a menos.

---

## Decisao do Bruno

- [ ] Aprovado — `product-owner` cria missao em `docs/missoes/`
- [ ] Aprovado com mudancas: <quais>
- [ ] Adiar — motivo: <qual>
- [ ] Recusar — motivo: <qual>

---

## Perguntas-Chave em Aberto (Bruno precisa responder antes de virar missao)

### Pergunta 1 — Catalogo de cursos: campo novo em bot_media ou tabela separada?

**Opcao A — Simples:** Adicionar coluna `curso_slug` em `bot_media`. Cada midia fica marcada com o curso ao qual pertence (ex: `barbeiro_profissional`, `coloracao`). A lista de cursos disponivel e inferida das midias ativas. Menos trabalho, pronto em 006-A.

**Opcao B — Estruturada:** Criar tabela `bot_courses` (slug, nome, descricao, preco, duracao). Painel ganha tela "Cursos" onde Bruno cadastra cada curso com seus dados. Midias ficam vinculadas por `course_id`. Mais flexivel para quando tiver 5+ cursos, mas exige mais desenvolvimento e ADR do arquiteto.

> Bruno, hoje quantos cursos distintos a Startap oferece ou planeja oferecer em 6 meses? Se forem ate 3, Opcao A resolve. Se vier a ser um catalogo maior, vale a Opcao B.

---

### Pergunta 2 — O marcador `[VIDEO:slug]` deve ser unico por conversa ou pode repetir?

Cenario: lead pergunta sobre certificado, bot manda video de certificado. Lead muda de assunto, volta para certificado. O bot manda o video de certificado de novo?

**Opcao A — Nao repete nunca:** Bot registra todos os IDs enviados na memoria. Se o lead perguntar de novo, o bot responde em texto sem reenviar.

**Opcao B — Repete se o lead pedir explicitamente:** Regra: video automatico por contexto nao repete; video por pedido explicito ("manda de novo") sempre reenvia.

> Bruno, qual comportamento parece mais natural pra um vendedor humano fazendo o mesmo papel?

---

### Pergunta 3 — Os 5 videos atuais (demo_corte_degrade_1, demo_corte_degrade_2, presencial_alunos_formados, presencial_alunos_cortando, online_degrade_apresentacao) — a qual curso pertencem e qual e o video de apresentacao principal?

Para a fase 006-A funcionar, precisamos saber:
- Esses videos pertencem todos ao "Curso de Barbeiro Profissional" ou ha cursos distintos aqui?
- Qual deles e o "video de apresentacao" que o bot manda quando o lead escolhe o curso?
- Qual e o contexto de cada um (quando a IA deve encaixa-lo na conversa)?

> Bruno, se puder preencher uma tabela simples: `slug | titulo | curso | quando enviar | e a apresentacao?` — isso vira direto a configuracao inicial da biblioteca.
