# ADR 0036 — Integração incremental do redesign na landing existente

- **Status:** Proposto para review do PM; conceito visual aprovado pelo Bruno em 2026-08-12
- **Data:** 2026-08-12
- **Autor:** arquiteto
- **Relacionados:** Missão 026 · Missão 023 W6/W7/W12 · ADR 0030 (produtização self-service)

## Contexto

A landing oficial já é a raiz pública do `@startap/portal-web` em `apps/portal-web/src/app/page.tsx`. Ela compartilha o domínio `app.startap.tech` com login, cadastro e portal autenticado, e já oferece signup, demo pública, ajuda, canais sociais e redirecionamento de sessão.

O conceito aprovado é um HTML isolado com CSS, listeners, canvas e atualização de cenários por `innerHTML`. Copiá-lo literalmente criaria botões inertes, lifecycle fora do React e risco de regressão em funcionalidades entregues pela Missão 023. Criar outro app ou domínio duplicaria autenticação, deploy e tokens visuais sem necessidade.

O redesign deve superar 300 linhas de diff, mas não introduz capability, dado ou stack nova. A decisão arquitetural necessária é apenas fixar a fronteira e a reversibilidade da integração.

## Decisão

Integrar o redesign **no app e na rota existentes**, preservando `page.tsx` como Server Component responsável por sessão e mantendo a composição visual em `landing.tsx`.

A interação visual será extraída para um Client Component pequeno e isolado. Cenários serão dados tipados renderizados por JSX; não será usado `innerHTML`/`dangerouslySetInnerHTML`. Efeitos imperativos terão cleanup completo e respeitarão `prefers-reduced-motion`, página oculta e JavaScript indisponível.

Estilos novos serão locais à landing (CSS module ou escopo equivalente), sem alterar tokens globais para acomodar o protótipo. Não será adicionada dependência GSAP ou outra biblioteca visual.

Os contratos `/cadastro`, `/login`, `/demo`, HelpFab, canais sociais e rotas legais `/termos` e `/privacidade` permanecem. Componentes e rota da demo atual não serão removidos na primeira PR, mesmo que deixem de compor a página, para garantir rollback por um único revert.

Não haverá DB, migration, env, backend, novo domínio ou mudança de deploy.

## Consequências

**Positivas:**

- Reutiliza autenticação, CI/CD, tokens e URLs canônicas já operacionais.
- Isola animação do conteúdo server-rendered e reduz superfície de regressão.
- Mantém rollback simples, sem estado externo ou restauração de dados.
- Evita nova dependência e preserva o monolito modular.

**Negativas:**

- A primeira PR pode deixar componentes antigos sem uso até medição e cleanup posterior.
- O showcase exige JavaScript para interação; o conteúdo, porém, deve permanecer legível sem ele.
- CSS e componente dedicados aumentam arquivos, em troca de não contaminar estilos globais.

## Rollback

Reverter a PR do redesign. Como rotas, integrações e componentes anteriores permanecem no repositório e nenhum estado externo muda, o comportamento visual anterior volta sem migration, env ou intervenção operacional.

## Alternativas consideradas

1. **Copiar HTML/CSS/JS integralmente para `landing.tsx`.** Rejeitada: botões sem integração real, `innerHTML`, listeners globais e cleanup frágil.
2. **Criar app/site estático ou domínio separado.** Rejeitada: duplica deploy, navegação e fronteira de autenticação para uma mudança visual.
3. **Adicionar GSAP para reproduzir a animação.** Rejeitada: o conceito usa Web APIs suficientes; nova dependência não traz benefício proporcional e amplia risco de performance/lifecycle.
4. **Remover imediatamente demo e componentes antigos.** Rejeitada nesta missão: mistura redesign com retirada de capability e encarece rollback. Pode ser avaliada depois com dados de uso.

## Critérios de aceitação arquiteturais

- A fronteira server/client permanece explícita: sessão no Server Component; interação no Client Component.
- Nenhum contrato público listado na Missão 026 é removido ou recebe destino diferente.
- CSS da landing não muda login, cadastro ou shell autenticado.
- Cenários não usam HTML dinâmico e não contêm PII.
- Sem dependência, DB, migration, env, backend ou infraestrutura novos.
- Um único revert restaura a landing anterior.
