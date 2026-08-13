# Missão 026 — Integrar o redesign aprovado da landing em produção

**DRI:** frontend-engineer
**Agentes envolvidos:** frontend-engineer (implementação), qa-tester (build e smoke visual), security (review da fronteira client-side)
**Apetite:** pequeno (1–2 dias, uma PR de frontend)
**Status:** pronta para implementação; publicação em produção aprovada pelo Bruno em 2026-08-12
**ADR:** 0036 — integração incremental do redesign na landing existente
**PR-FAQ:** dispensado — redesign visual sem capability nova

---

## Contexto

A raiz pública já vive no `@startap/portal-web`: usuário com sessão segue para `/inicio`; usuário sem sessão vê a landing. A Missão 023 criou a landing multi-vertical, a demo pública e os canais de ajuda/social (W6/W7/W12; commits `ecca8f8` e `dee9497`).

Bruno aprovou o conceito visual em `/Users/bruno/.codex/visualizations/2026/08/13/019ff87e-5fd0-7700-928a-879c022993d7/startap-landing-proposta.html`. A missão é portar esse conceito para o produto oficial sem transformar um redesign em mudança de arquitetura ou regressão do funil existente.

## Objetivo

Atualizar a apresentação visual da landing em `/`, preservando integralmente os contratos públicos existentes e mantendo a mudança reversível por um único revert de PR.

## Escopo

- Integrar o conceito no `apps/portal-web`, sem criar app, domínio ou pipeline de deploy.
- Manter `apps/portal-web/src/app/page.tsx` como fronteira server-side de sessão.
- Implementar a parte interativa como Client Component isolado; renderizar os cenários como dados → JSX, sem `innerHTML` ou `dangerouslySetInnerHTML`.
- Escopar os estilos da landing para não alterar login, cadastro nem o shell autenticado.
- Reutilizar componentes, tokens e URLs canônicas do produto onde já existirem.

## Contratos que não podem regredir

- `/cadastro`: todos os CTAs de teste/criação de conta continuam levando ao signup real, inclusive seu degrade quando o signup estiver indisponível.
- `/login`: acesso continua visível e funcional; sessão existente em `/` continua redirecionando para `/inicio`.
- `/demo`: rota pública e integração atuais permanecem disponíveis; nenhum contrato de API é removido nesta missão.
- `HelpFab`: ajuda via WhatsApp continua presente e usa a URL centralizada existente.
- Rodapé: WhatsApp, Instagram, acesso e as rotas legais `/termos` e `/privacidade` continuam alcançáveis.
- Copy de 7 dias, sem cartão, uso do próprio número e controle pelo dono não pode prometer comportamento diferente do produto real.

## Definition of Done (DoD)

- [ ] A implementação altera apenas `apps/portal-web`; zero mudança em DB, migration, env, API ou infraestrutura.
- [ ] `/` mantém o contrato: com sessão → `/inicio`; sem sessão → landing.
- [ ] CTAs de topo, hero e fechamento apontam para `/cadastro`; “Entrar” aponta para `/login`.
- [ ] `/demo`, `HelpFab`, WhatsApp, Instagram, `/termos` e `/privacidade` permanecem funcionais e alcançáveis por teclado.
- [ ] Nenhum HTML de cenário é injetado; conteúdo ilustrativo não contém PII nem é apresentado como conversa real de cliente.
- [ ] Conteúdo essencial nasce visível; com JavaScript desligado ou `prefers-reduced-motion: reduce`, a proposta continua compreensível.
- [ ] Todo `requestAnimationFrame`, listener, `ResizeObserver` e media query criados pelo componente interativo têm cleanup; animação pausa com a página oculta.
- [ ] Biome do escopo, testes do portal e `next build` verdes, executados pelo qa-tester.
- [ ] Smoke humano no navegador em 390 px e desktop: CTAs, foco/teclado, cenários, overflow, tema, reduced motion, login e cadastro.
- [ ] PR revisada por qa-tester e security antes de merge; CI verde e deploy verificado separadamente após o merge.

## Rollback

Reverter a única PR da missão. Os componentes e a rota `/demo` existentes não serão removidos na primeira entrega, então o rollback não exige restaurar dados, env, imagem ou migration.

## Fora de escopo

- Alterar signup, login, autenticação, billing, API da demo ou comportamento do bot.
- Remover componentes/rotas legados da landing; cleanup só em missão posterior com medição.
- Adicionar GSAP, biblioteca visual, fonte externa, analytics ou serviço de terceiros.
- Alterar domínio público, Docker, Nginx Proxy Manager, workflow de CI/CD ou produção durante a implementação.
- Reescrever textos legais, versões de termos ou política de privacidade.

## Riscos

- **Conversão:** uma cópia visual literal do protótipo deixaria botões sem destino e reduziria conteúdo comercial já vivo. Mitigação: contratos acima são DoD bloqueante.
- **Performance mobile:** canvas contínuo e efeitos por ponteiro podem causar jank. Mitigação: orçamento pequeno de animação, pausa em background e smoke em aparelho estreito.
- **Acessibilidade:** conteúdo escondido esperando animação falha com reduced motion ou JS off. Mitigação: estado inicial visível e movimento como aprimoramento progressivo.
- **Escopo:** aproveitar o redesign para remover `/demo` tornaria o rollback mais caro. Mitigação: preservação explícita nesta missão.

## Dependências

- Conceito visual aprovado pelo Bruno.
- ADR 0036 revisado pelo PM antes da implementação.
- ADR 0030 como referência do funil self-service; esta missão não muda suas decisões.
