# ADR 0005: Direcao visual e sistema de design do painel admin

**Status:** Aceita
**Data:** 2026-05-17
**Revisado em:** 2026-05-18
**Autor:** arquiteto
**Aprovado por:** Bruno — 2026-05-18 (decisao original) / 2026-05-18 (revisao)

---

## Revisao da decisao (2026-05-18)

**Decisao original** (PR #56): Opcao C — Linear-like operacional com estrutura Stripe.
A entrega foi realizada e a PR mergeada.

**Feedback do Bruno apos ver o resultado:**

> "ficou simples demais. Quero bem mais profissional, controlar tudo bem detalhado pelo painel."

**Nova direcao:** Retool/Supabase admin denso. Sidebar agrupada em 3 grupos com sub-itens
colapsaveis, KPI strip em linha unica, tabelas densas com acoes inline, atividade ao vivo.

**O que e mantido da PR #56:**
- Tokens CSS completos (cores, spacing, tipografia, shadows, radius) — reusados sem alteracao
- Tema exclusivamente escuro
- Breakpoint minimo 768px
- Video de treinamento fora de escopo (Missao 004)

**O que muda:**
- Estrutura de navegacao: sidebar plana → sidebar agrupada em 3 grupos colapsaveis
- Densidade: cards separados → KPI strip em linha unica; tabelas com acoes inline
- Atividade ao vivo: feed de mensagens em tempo real no dashboard
- Secoes de CONFIGURACAO promovidas para grupo dedicado no nav

---

## Decisao final (2026-05-18 — revisao)

| # | Decisao | Escolha |
|---|---|---|
| 1 | Direcao visual | **Retool/Supabase admin denso** — sidebar agrupada, densidade alta |
| 2 | Tema | **So escuro** — modo claro fora de escopo desta missao |
| 3 | Breakpoint mobile minimo | **768px** (tablet landscape) — sem suporte a 480px/360px |
| 4 | Video para treinar agentes | **Fora de escopo** — vai para Missao 004 separada |
| 5 | Tokens CSS (PR #56) | **Reusados integralmente** — nenhum token de cor/spacing muda |

---

## Mockup de referencia — Retool/Supabase admin denso

```
┌─ STARTAP ──────────────────────────────────────────────────┐
│ ▾ DASHBOARD     │ MSG·7d  EXEC·HJ  LEADS·24h  TOKENS·7d   │
│   ▸ Visao geral │ 1.247    142/89%   18         432K       │
│ ▾ OPERACAO      │ ▲ 18%    ▲ 4%      ▼ 2%       $4.89      │
│   ▸ Bots        │━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│   ▸ Sessoes WAHA│ SESSOES WAHA  [Filtrar▾]  [+ Nova]      │
│   ▸ Leads       │ teste_barbearia ● ON    3min    2     [···]│
│   ▸ Roteamento  │ teste_vendas    ● ON    8min    1     [···]│
│ ▾ CONFIGURACAO  │ startap         ● OFF   1h      —     [···]│
│   ▸ Prompts     │━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│   ▸ Modelo IA   │ ATIVIDADE · ao vivo                       │
│   ▸ Midia       │ 14:32  +5519…  → vendas_barb  ✓ 250ms │
│   ▸ Webhooks    │ 14:31  +5511…  → barbearia    ✓ 180ms │
│   ▸ Limpeza     │ 14:30  +5596…  → barbearia    ✓ 220ms │
└─────────────────┴──────────────────────────────────────────┘
```

### Navegacao esperada

```
▾ DASHBOARD
    ▸ Visao geral

▾ OPERACAO
    ▸ Bots
    ▸ Sessoes WAHA
    ▸ Leads
    ▸ Roteamento
    ▸ Execucoes

▾ CONFIGURACAO
    ▸ Prompts
    ▸ Modelo IA
    ▸ Midia
    ▸ Webhooks
    ▸ Limpeza
```

### Principios de densidade

- **KPI strip:** 4 metricas em linha unica (MSG 7d / EXEC HJ / LEADS 24h / TOKENS 7d),
  com valor primario monospace e delta percentual abaixo
- **Tabelas densas:** padding reduzido, acoes inline `[···]` (menu contextual por linha),
  sem card wrapper separado por item
- **Atividade ao vivo:** feed cronologico no dashboard com timestamp, numero de origem,
  bot destino e latencia — atualizado via polling curto ou SSE
- **Sidebar colapsavel por grupo:** cada grupo (DASHBOARD / OPERACAO / CONFIGURACAO)
  e independentemente colapsavel; estado persistido em localStorage

---

## Contexto

O `painel-admin/public/index.html` tem ~3 000 linhas de HTML + CSS inline +
JS vanilla. A base tecnica e solida: tokens CSS existem, Inter + JetBrains
Mono estao carregados, componentes (btn, badge, card, table, toast, drawer)
estao definidos. O problema e de **hierarquia e coerencia visual**, nao de
ausencia de tokens:

- Upload de midia usa `.upload-area` com dashed border mas sem estado de
  progresso, sem preview inline antes do submit, sem mensagem de erro
  contextual. O resultado visual e ambiguo.
- Media cards para agentes usam `.media-card` com `.media-card__preview`
  de altura fixa (140px min-height), mas video e renderizado com `<video>`
  inline sem controles de aspecto, sem thumbnail poster, sem lazy load. Em
  conexao lenta, a grid trava.
- Roteamento WAHA esta enterrado dentro da aba de cada bot (`.routing-row`),
  mas `routing_clientes` e uma tabela unica global — o modelo mental do
  painel contradiz a arquitetura real.
- Espacamento e inconsistente: alguns cards tem `padding: 1rem`, outros
  `padding: .625rem .75rem`, o gap da `.dash-grid` e 1rem mas o da
  `.kpi-grid` tambem — sem uma escala explicita de spacing.
- Sem hierarquia de layout clara entre secoes densas (leads, bots) e secoes
  operacionais (roteamento, sessoes WAHA).

**Restricoes fixas:**
- Stack permanece Express + HTML/CSS/JS vanilla — sem bundler novo, sem
  framework JS.
- Modelo de dados nao muda (`/api/bots`, `/api/routing`, `/api/leads`, etc).
- CSS vai para 1-2 arquivos separados; JS vanilla mantido.
- Roteamento deve virar secao global de primeiro nivel no menu.

---

## Decisao (original — 2026-05-17)

Adotar a **Direcao C — Linear-like operacional com estrutura Stripe**
(descrita abaixo) como sistema de design do painel. Extrair todo CSS inline
para `painel-admin/public/design-system.css` e `painel-admin/public/app.css`.
Substituir o upload de midia por um componente com estado de progresso
explicito. Promover Roteamento para item fixo no nav de primeiro nivel.
Implementar em 4 fases (1 PR cada), sem quebrar o modelo de informacao atual.
**O tema sera exclusivamente escuro nesta missao.** O breakpoint mobile minimo
e 768px (tablet landscape).

**Esta decisao foi superada pelo feedback do Bruno em 2026-05-18.** Os tokens
CSS entregues na PR #56 sao mantidos; a estrutura de navegacao e densidade
sao substituidas pela direcao Retool/Supabase admin descrita acima.

---

## Alternativas consideradas

### Opcao A — Vercel-like minimalista

**Filosofia:** muito espaco em branco, tipografia geometrica, bordas ultra-finas,
acoes quase invisiveis ate o hover. Priorizou elegancia sobre densidade.

**Sistema de tokens proposto:**
```
Cores:    bg #fff | surface #fafafa | border #e5e7eb | text #111827
          primary #000 | success #16a34a | danger #dc2626
Tipo:     14px base, 4 niveis (24/16/14/12px), weight 400/500/600
Spacing:  escala 4-8-12-16-24-32-48-64px
Radius:   4/8/16px
Shadows:  nenhuma (so bordas)
```

**Mockup ASCII — Dashboard:**
```
+----------------------------------------------------------+
|  startap          Dashboard                              |
|  ─────────────────────────────────────────────────────── |
|  Dashboard        Bots ativos   Leads hoje   Sessoes ok  |
|  Leads            4             23           3 / 4       |
|  Bots                                                    |
|  Roteamento       ─────────────────────────────────────  |
|  Sessoes          Ultimos leads                          |
|                   Nome         Bot          Hora         |
|                   Ana Lima     barbearia    14:32        |
|                   Jose S.      vendas       14:18        |
+----------------------------------------------------------+
```

**Vantagens:**
- Producao mais rapida (menos decisoes de cor)
- Parece moderno e limpo

**Desvantagens:**
- Fundo branco nao combina com o tema escuro atual — regressao para Bruno e Icaro
- Muito espaco em branco desperdicado em telas de leads com muitas colunas
- Acoes sutis aumentam o tempo de descoberta para novos usuarios

**Descartada porque:** o painel e uma ferramenta operacional densa. Espaco em
branco e bom em produto consumer; aqui reduz a quantidade de informacao
visivel sem ganho real de clareza. Adicionalmente, exigiria reescrever todos
os tokens de cor do zero, regressao grande sem ROI.

---

### Opcao B — Notion-like hierarquico

**Filosofia:** breadcrumbs, icones Lucide consistentes, hierarquia de paginas,
sidebar expandivel com subitens. Focou em navegabilidade.

**Sistema de tokens proposto:**
```
Cores:    bg #ffffff | surface #f7f6f3 | border #e9e9e7 | text #37352f
          primary #2383e2 | success #0f7b6c | danger #e03e3e
Tipo:     16px base, Geist Sans, 4 niveis
Spacing:  escala 4-8-16-24-32-48px
Radius:   3/6/12px
Shadows:  leve (0 1px 3px rgba(0,0,0,.1))
```

**Mockup ASCII — Dashboard:**
```
+----------------------------------------------------------+
| > startap /dashboard                                     |
| ┌──────────────────────────────────────────────────────┐ |
| │ Bots ativos [4]  Leads hoje [23]  Sessoes [3/4]      │ |
| └──────────────────────────────────────────────────────┘ |
| Leads recentes                           [Ver todos →]   |
| ┌──────────┬──────────┬──────────┬──────────────────── ┐ |
| │ Nome     │ Telefone │ Bot      │ Hora                 │ |
| │ Ana Lima │ 55199... │ barbeari │ ha 12 min            │ |
| └──────────┴──────────┴──────────┴──────────────────── ┘ |
+----------------------------------------------------------+
```

**Vantagens:**
- Breadcrumbs ajudam orientacao em paineis com muitas secoes
- Icones Lucide tem licenca MIT, CDN estavel

**Desvantagens:**
- Tom claro incompativel com o ambiente atual (tela escura preferida por Bruno)
- Sidebar expandivel com subitens aumenta complexidade de JS vanilla
- Notion e um editor de documentos — o painel e uma ferramenta de operacao

**Descartada porque:** o modelo mental do Notion (hierarquia de paginas) nao
mapeia bem para secoes planas de um painel operacional. Adicionaria JS extra
para sidebar expansivel sem beneficio real.

---

### Opcao C — Linear-like operacional com estrutura Stripe — **SUPERADA**

> **Nota (2026-05-18):** Esta opcao foi implementada na PR #56 e superada pelo
> feedback do Bruno. Os tokens CSS desta opcao sao mantidos integralmente.
> A estrutura de navegacao e densidade sao substituidas pela direcao
> Retool/Supabase admin descrita na secao "Revisao da decisao" acima.

**Filosofia:** painel escuro denso, sidebar fixa com icones alinhados e
labels legivel, metricas em monospace, badges compactos, sem decoracao.
Cada pixel justifica presenca. O tom e de ferramenta profissional para
quem ja conhece o produto — nao onboarding, nao consumer. Inspirado no
Linear (densidade, escuro, monospace nos numeros) e no Stripe Dashboard
(hierarquia de cards, sombras sutis, foco em metrica).

**Sistema de tokens proposto:**
```
Cores semanticas (mantendo os existentes, ajustando hierarquia):
  --bg:           #0a0f1e   (fundo base — mantido)
  --bg-2:         #0f172a   (sidebar, modais — mantido)
  --surface:      #111827   (cards — MUDANCA: era #1e293b, escurece 1 grau)
  --surface-2:    #1e293b   (hover de card, inputs — MUDANCA: era #263247)
  --surface-3:    #253347   (bordas internas, thead)
  --border:       #1e3a5f   (mantido)
  --border-light: #2d4a6e   (mantido)
  --text:         #f1f5f9   (mantido)
  --text-muted:   #94a3b8   (mantido)
  --text-subtle:  #64748b   (mantido)
  --primary:      #3b82f6   (mantido)
  --primary-hover:#2563eb   (mantido)
  --primary-glow: rgba(59,130,246,0.15) (reducao de intensidade)
  --success:      #10b981   (mantido)
  --warning:      #f59e0b   (mantido)
  --danger:       #ef4444   (mantido)
  --info:         #38bdf8   (mantido)

Tipografia (ajuste de escala, mesmas fontes):
  --text-xs:   .6875rem  (11px) — labels uppercase, badges
  --text-sm:   .8125rem  (13px) — tabelas, captions, muted
  --text-base: .875rem   (14px) — corpo padrao
  --text-md:   1rem      (16px) — titulos de secao
  --text-lg:   1.25rem   (20px) — KPI valores secundarios
  --text-xl:   1.75rem   (28px) — KPI valores primarios (monospace)

Spacing (escala 4px-base, nomes explicitos):
  --space-1:  .25rem   (4px)
  --space-2:  .5rem    (8px)
  --space-3:  .75rem   (12px)
  --space-4:  1rem     (16px)
  --space-5:  1.25rem  (20px)
  --space-6:  1.5rem   (24px)
  --space-8:  2rem     (32px)
  --space-10: 2.5rem   (40px)
  --space-12: 3rem     (48px)

Radius (manter o existente, consolidar):
  --radius-sm: 4px
  --radius-md: 8px
  --radius-lg: 10px  (MUDANCA: era 12px — levemente mais contido)
  --radius-xl: 14px
  --radius-full: 9999px

Shadows (adicionar nivel intermediario):
  --shadow-xs: 0 1px 2px rgba(0,0,0,.5)
  --shadow-sm: 0 2px 4px rgba(0,0,0,.4)    (era shadow-sm)
  --shadow-md: 0 4px 12px rgba(0,0,0,.3)   (mantido)
  --shadow-lg: 0 8px 32px rgba(0,0,0,.4)   (mantido)
```

**Mockup ASCII — Dashboard (Opcao C — base preservada, estrutura reorganizada):**
```
+--sidebar(240px)--+--main content-----------------------------------------+
| [S] Startap      | Dashboard                          [Atualizar]         |
|   Painel         | ─────────────────────────────────────────────────────  |
|─────────────────|                                                          |
| # Dashboard      | ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  |
| @ Leads          | │ Leads    │ │ Bots     │ │ Sessoes  │ │ Msgs     │  |
| □ Bots           | │          │ │          │ │          │ │          │  |
| ↔ Roteamento     | │  1.234   │ │   4 / 4  │ │  3 / 4   │ │  892     │  |
| ◉ Sessoes WAHA   | │  leads   │ │  ativos  │ │  online  │ │  hoje    │  |
|─────────────────| │ +12 hoje  │ │          │ │ ⚠ 1 off  │ │          │  |
| v0.x.x           | └──────────┘ └──────────┘ └──────────┘ └──────────┘  |
+------------------+                                                         |
                   | ┌─ Leads recentes ────────────────┐ ┌─ Bots ────────┐  |
                   | │ NOME         BOT      HORA      │ │ barbearia [●] │  |
                   | │─────────────────────────────────│ │ vendas    [●] │  |
                   | │ Ana Lima     barbearia  14h32   │ │ misto     [●] │  |
                   | │ Jose Silva   vendas     14h18   │ │ startap   [●] │  |
                   | │ Maria C.     misto      13h55   │ └───────────────┘  |
                   | │ [Ver todos leads →]             │                    |
                   | └─────────────────────────────────┘                    |
                   +────────────────────────────────────────────────────────+
```

**Mockup ASCII — Upload de midia (componente reformulado):**
```
┌─ Upload de Midia ──────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │          [↑]  Arraste arquivos ou clique para selecionar         │   │
│  │          MP4 / WebM / JPG / PNG / PDF — max 50 MB               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  [Fazendo upload: video_intro.mp4]  ████████░░░░░░░░  62%  [x]        │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│  │ [▶ preview]      │  │ [▶ preview]      │  │ [▶ preview]      │     │
│  │ 16:9 thumbnail   │  │ 16:9 thumbnail   │  │ 16:9 thumbnail   │     │
│  │──────────────────│  │──────────────────│  │──────────────────│     │
│  │ video_intro.mp4  │  │ foto_barba.jpg   │  │ preco_lista.pdf  │     │
│  │ 12.3 MB  [⋮]    │  │ 980 KB   [⋮]    │  │ 2.1 MB   [⋮]    │     │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Mockup ASCII — Roteamento (secao global):**
```
+─ Roteamento ──────────────────────────────────────────────────────────────+
| Tabela routing_clientes — roteamento global por numero de telefone        |
| [+ Adicionar regra]                                                       |
|─────────────────────────────────────────────────────────────────────────  |
| TELEFONE (prefixo)   BOT ALVO          CRIADO EM      ACOES              |
| 5511                 teste_barbearia   2026-01-10      [editar] [remover] |
| 5521                 teste_vendas      2026-02-03      [editar] [remover] |
| *                    startap           —               [padrao]           |
+───────────────────────────────────────────────────────────────────────────+
```

**Vantagens:**
- Evolucao do que existe — tokens ja mapeados, mudancas sao de ajuste, nao
  de reescrita completa. Risco de regressao minimo.
- Densidade adequada ao uso real (Bruno e Icaro olham muito dado por tela).
- Monospace nos numeros KPI e uma convencao do Linear que melhora
  leitura de metricas variavel-largura.
- Roteamento como secao de primeiro nivel resolve o bug conceitual do painel.
- Upload com barra de progresso resolve a principal reclamacao funcional.

**Desvantagens:**
- Escurece levemente `--surface` (era `#1e293b`, vai para `#111827`) —
  pode reduzir contraste em monitores mal calibrados. Mitigacao: manter
  `--text` em `#f1f5f9` (ratio WCAG AA garantido).
- Nao resolve o problema de build/bundler a longo prazo — mas isso esta
  fora do escopo deste ADR.

---

## Componentes base (sistema de design — tokens reusados da PR #56)

### Botao (4 variantes)
```
.btn              — secundario (surface + border)
.btn--primary     — primario (azul solido)
.btn--ghost       — fantasma (sem fundo, sem borda)
.btn--danger      — destrutivo (vermelho solido)

Tamanhos: .btn--sm | [padrao] | .btn--lg (novo — 40px height)
Icone:    .btn--icon (quadrado, sem label)
```

### Card
```
.card             — fundo surface, borda, radius-lg, padding space-4
.card--flat       — sem padding (para tabelas embutidas)
.card--hover      — cursor pointer, hover com border-light
.card--highlight  — borda primary-glow (usado em item selecionado)
```

### Tabela
```
.table-wrap > .table
th: uppercase, text-xs, text-muted, bg rgba(0,0,0,.2)
td: text-base, padding space-2 space-4
tr:hover: fundo rgba(255,255,255,.02)
Sem zebra-striping — borda inferior em cada row e suficiente
```

### Form Field
```
.field > label + input|select|textarea
label: text-xs, uppercase, font-weight 600, text-muted
input: bg bg-2, border, radius-md, padding space-1 space-3
focus: border-color primary, box-shadow primary-glow
error: border-color danger, .field__error abaixo em text-xs danger
```

### Modal
```
.modal-backdrop > .modal
modal: max-width 520px, padding space-6, radius-xl, surface, shadow-lg
modal__header: flex, space-between, border-bottom, padding-bottom space-4
modal__footer: flex, gap space-2, justify-end, border-top, padding-top space-4
Fechar: btn--ghost btn--icon no header
```

### Toast
```
.toast--success | .toast--danger | .toast--warning | .toast--info
Posicao: fixed bottom-right, z 9999
Duracao: 4s auto-dismiss, progress bar interna
Max simultaneos: 4 (remover o mais antigo se exceder)
```

### Tab
```
.tabs (pill — existente) — manter para sub-navegacao dentro de secao
.tabs--underline (novo) — para navegacao primaria dentro de um card grande
  tab-btn: sem fundo, borda inferior 2px primary quando ativo
```

### Badge
```
.badge--success | --danger | --warning | --info | --muted
.badge--dot — ponto colorido antes do texto
.badge--outline (novo) — borda colorida, fundo transparente
Tamanho unico: text-xs, padding 2px 8px, radius-full
```

### Icones
- **Biblioteca:** Lucide Icons via CDN (`unpkg.com/lucide@latest/dist/umd/lucide.min.js`)
- **Tamanhos padrao:** 14px (inline em badge/label), 16px (botoes, nav), 20px (secao header), 24px (empty state)
- **Remover:** SVG inline embutido no `<script>` atual (linhas 840-870 do index.html)
- **Manter:** a funcao `icon()` como wrapper, adaptada para chamar `lucide.createElement`

### Empty states
```
.empty-state: flex column, align center, gap space-3, padding space-12 space-6
  .empty-state__icon: icone Lucide 40px, opacity .35
  .empty-state__title: text-md, font-weight 600
  .empty-state__text: text-sm, text-muted, max-width 30ch
  .empty-state__action: .btn--primary (opcional)
```

### Error states
```
.error-state: igual ao empty-state, icon em --danger opacity .5
Inline (campo): .field__error abaixo do input, text-xs danger
Banner: .alert--danger (novo) — fundo danger-bg, borda danger, radius-md, padding space-3 space-4
```

---

## Plano de implementacao

**Restricoes derivadas das decisoes finais:**
- Sem `@media (prefers-color-scheme: light)` — tema unico escuro.
- Media queries de responsividade: breakpoint minimo `768px`. Sem regras para 480px ou 360px.
- Nenhum componente de video de treinamento de agentes nesta missao (escopo na Missao 004).

### Fase 1 — Tokens + reset + componentes base (1 PR)
**Arquivos:**
- Criar `painel-admin/public/design-system.css` com todos os tokens CSS,
  reset, tipografia, spacing, e os 8 componentes base acima
- Mover o `<style>` do `index.html` para esse arquivo (exceto estilos de
  layout de secao especificos que vao para `app.css`)
- Criar `painel-admin/public/app.css` para layout shell, sidebar, main,
  secoes, media queries (breakpoint minimo 768px)
- `index.html` fica so com `<link>` para os dois arquivos

**Criterio de aceitacao:**
- `index.html` sem nenhum `<style>` inline
- Painel carrega identico visualmente ao estado pre-PR
- Nenhum console.error de recurso faltando

**Responsavel:** dev-front
**Esforco:** M (1-2 dias)

---

### Fase 2 — Dashboard Retool/Supabase admin denso (1 PR)

> **Revisado em 2026-05-18:** substituiu "PR-vitrine Linear-like" pela direcao
> Retool/Supabase admin densa com KPI strip, tabelas densas e atividade ao vivo.

**Arquivos:**
- `index.html` — secao `#section-dashboard` refeita com KPI strip em linha
  unica, feed de atividade ao vivo, tabelas densas com acoes inline
- `app.css` — sidebar agrupada em 3 grupos colapsaveis (JS vanilla);
  estado de colapso persistido em localStorage
- `design-system.css` — `.kpi-strip`, `.kpi-strip__item`, `.activity-feed`,
  `.activity-feed__row` adicionados como componentes de densidade alta

**Criterio de aceitacao:**
- Dashboard exibe KPI strip com 4 metricas em linha unica (monospace)
- Sidebar exibe 3 grupos colapsaveis independentemente
- Feed de atividade exibe ultimas 10 acoes com timestamp, origem, destino e latencia
- Tabela de Sessoes WAHA tem acoes inline `[···]` por linha
- Bruno aprova visualmente antes de Fase 3

**Responsavel:** dev-front
**Esforco:** M (1-2 dias)

---

### Fase 3 — Propagacao por secao (1 PR por secao, pode ser paralelo)

**Ordem de prioridade:**
1. **Roteamento** — promover para nav de primeiro nivel; usar `.table-wrap`
   padrao; remover do interior das abas de bot
2. **Upload de midia** — substituir `.upload-area` por componente com
   progress bar (`<progress>` nativo estilizado) e grid de preview com
   aspect-ratio 16/9 para video
3. **Leads** — padronizar tabela + filtros + drawer de detalhe
4. **Bots** — tabs internas usando `.tabs--underline`; media cards com
   poster thumbnail lazy
5. **Sessoes WAHA** — grid de session cards padronizado
6. **Configuracoes / outros** — limpeza de estilos residuais

**Criterio de aceitacao por secao:**
- Nenhum estilo `style=""` inline no HTML gerado por JS
- Cada secao passa no axe DevTools (sem erros de acessibilidade criticos)
- 768px: nenhum overflow horizontal (breakpoint minimo aprovado)

**Responsavel:** dev-front
**Esforco:** L total (3-5 dias distribuidos)

---

### Fase 4 — Ajustes finos + cleanup (1 PR)
**Arquivos:**
- Remover classes CSS mortas de `design-system.css` e `app.css`
  (usar PurgeCSS manualmente ou grep por classe nao referenciada)
- Unificar magic numbers residuais em variaveis de spacing
- Testar em 768px, 1024px, 1440px, 1920px

**Criterio de aceitacao:**
- `design-system.css` + `app.css` sem classe definida mas nao usada
- Sem `px` hardcoded fora de `border-width` e `box-shadow` spread
- Screenshot comparativo antes/depois aprovado pelo Bruno

**Responsavel:** dev-front + tester
**Esforco:** S (meio dia)

---

## Riscos e mitigacoes

| Risco | Probabilidade | Impacto | Mitigacao |
|---|---|---|---|
| Mudanca de tokens escurece cards, reduz contraste | Media | Medio | Testar ratio WCAG AA com contrast checker antes de Fase 2 |
| Lucide CDN indisponivel | Baixa | Alto | Pinned version no CDN; fallback inline SVG para os 10 icones mais usados |
| Fase 3 paralela gera conflito de merge em index.html | Alta | Medio | Cada PR de secao toca so o bloco HTML da secao + nao toca design-system.css |
| Upload novo quebra logica de POST existente | Baixa | Alto | Componente de progresso usa o mesmo endpoint; so o HTML/CSS muda, nao o fetch |
| Roteamento promovido a primeiro nivel muda URL hash | Baixa | Baixo | Hash `#roteamento` adicionado; links existentes continuam funcionando |
| Sidebar colapsavel aumenta complexidade JS vanilla | Media | Medio | Estado simples em localStorage; toggle de classe CSS; sem dependencia externa |

---

## Validacao

- `index.html` sem nenhuma tag `<style>` apos Fase 1
- Lighthouse Performance >= 90 (CSS separado melhora cache)
- Nenhum erro axe DevTools nas 4 secoes principais apos Fase 3
- Bruno e Icaro usam o painel por 1 semana sem reclamacao de UX regressiva
- Upload de midia completa com progress bar visivel em conexao de 10 Mbps
- KPI strip legivel em 768px sem quebra de layout

---

## Rollback

Cada fase e 1 PR isolada. Revert de PR e o rollback:
- Fase 1: `git revert <sha>` restaura `<style>` inline no index.html
- Fase 2: `git revert <sha>` restaura o bloco `#section-dashboard` anterior
- Fases 3-4: revert de PR por secao, independentes entre si

Sem migracao de banco, sem mudanca de API, sem risco de dados.

---

## Historico de decisoes

| Data | Evento |
|---|---|
| 2026-05-17 | ADR criado — Opcao C (Linear-like) aprovada por Bruno |
| 2026-05-18 | PR #56 mergeada — tokens CSS e estrutura Linear-like entregues |
| 2026-05-18 | Bruno: "ficou simples demais" — direcao revisada para Retool/Supabase admin denso |
| 2026-05-18 | ADR atualizado — tokens PR #56 reusados; sidebar agrupada e densidade alta adotados |

---

## Referencias

- [Lucide Icons](https://lucide.dev) — licenca ISC, CDN unpkg
- Linear Design System — https://linear.app (referencia visual — base superada)
- Retool Dashboard / Supabase Studio — referencia visual atual
- WCAG 2.1 AA — contraste minimo 4.5:1 para texto normal
- `painel-admin/public/index.html` — estado atual (~3000 linhas)
- ADR 0001: isolamento-memoria-por-clone (contexto de produto)
- PR #56 — entrega da Fase 2 Linear-like (tokens reusados nesta revisao)
