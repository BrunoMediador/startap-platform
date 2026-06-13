# ADR 0020: Shard de WAHA — Múltiplas Instâncias com Roteamento por Sessão/Tenant

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0020-shard-waha-por-tenant.md`
> **Quando usar:** Pilar 3 dos "3 pilares de escala" (decisão do Bruno, 2026-06-12). Dividir o container WAHA único em múltiplas instâncias para capacidade e blast radius — **sem mover as sessões no ar**.

---

**Status:** proposta — aguardando aprovação de Bruno
**Data:** 2026-06-12
**Autor:** arquiteto
**Aprovado por:** pendente
**Relacionados:** ADR 0018 (tenant_id — fornece a chave de roteamento futura), ADR 0019 (idempotência — pré-requisito de N instâncias da API), ADR 0003 (router/instâncias). Memórias: `feedback_waha_imagem_congelada`, `reference_waha_sessao_lifecycle`, `feedback_padrao_sessao_waha_nova`.

---

## Contexto

### Estado real (confirmado no servidor, 2026-06-12)

- **Um único container WAHA** (`automacoes-waha-1`, engine NOWEB/Baileys) atende **TODAS** as sessões. Volume `automacoes_waha_sessions`, creds em `/app/.sessions/noweb/<sessao>/`.
- Sessões on-disk hoje: `STARTAP_AI_PROD` (Lola), `cirilobarbearia` (Cirilo, PAGANTE), `barbearia_samuel` (Samuel, começa domingo), `WHATSAPP_ROUTER_TESTE` (teste), `barbeariacarlosolvv` (teste do Bruno), `clone_edu_barbeiro_glh7vd` (trial).
- **Imagem CONGELADA:** `devlikeapro/waha-plus` é doação, **NUNCA `docker pull`** (memória `feedback_waha_imagem_congelada`). Qualquer instância nova reusa a MESMA imagem local já presente no host.
- A API roteia por **sessão**: `findBotBySession(body.session)` (`registry.ts`) e `flow_clones.waha_sessao` mapeia slot → sessão. A API fala com a WAHA via `@startap/integrations` (`waha.downloadMedia`, envio). Hoje aponta para um único endpoint WAHA.
- Teto estimado nesta VPS: ~15-20 sessões por container (2 vCPU / 7.8 GiB / sem swap — memória `feedback_decisao_sem_swap`). Cada sessão NOWEB mantém socket Baileys + estado.

### A constraint dura e inegociável (palavra do Bruno)

**"Preservar a integridade dos agentes" = ZERO downtime e ZERO re-pareamento para os bots NO AR (Cirilo, Samuel, Lola).**

O auth NOWEB vive no volume `automacoes_waha_sessions` em `/app/.sessions/noweb/<sessao>/`. **Mover uma sessão existente entre containers/volumes é risco real de re-pareamento** (a sessão pode invalidar e exigir novo QR — perda inaceitável para cliente pagante). A imagem congelada agrava: não dá para "atualizar" para uma versão com migração de sessão mais robusta.

### Confirmação da hipótese do enunciado

**Hipótese do Bruno: o shard vale só para clientes NOVOS; os existentes ficam onde estão.** → **CONFIRMADA pelo design.** Mover sessão = risco de re-pareamento = viola a constraint dura. Portanto o shard é **aditivo por colocação**: o container WAHA atual (`automacoes-waha-1`, "shard 0") permanece intocado com Cirilo/Samuel/Lola/testes; clientes novos nascem em `automacoes-waha-2` (shard 1), etc. Migrar sessão existente entre shards só com janela explícita, número a número, com o cliente disponível para reparear se der errado — e nunca como parte deste rollout.

---

## Decisão

**Adotar sharding de WAHA por COLOCAÇÃO ADITIVA: subir containers WAHA adicionais (mesma imagem congelada, volume nomeado próprio por shard) e rotear na API por sessão→shard via um mapa de endpoints. O shard 0 (`automacoes-waha-1`) congela seu conjunto de sessões atuais; só clientes NOVOS são provisionados em shards novos. NENHUMA sessão existente é movida neste rollout.**

Mecânica:

1. **Registro de shard por sessão.** Adicionar ao `flow_clones` (ou a uma tabela `waha_shards` + coluna `flow_clones.waha_shard_id`) o endpoint/shard de cada sessão. Default = shard 0 (o container atual) → comportamento idêntico ao de hoje para todo mundo existente.
2. **Roteamento na camada de integração WAHA.** `@startap/integrations` deixa de ter um único base URL e passa a resolver o endpoint a partir do shard da sessão. O `registry`/router já tem a sessão em mãos (`body.session`) — basta mapear sessão → shard → URL.
3. **Provisioning de cliente novo escolhe o shard.** O onboarding aloca o cliente novo no shard com capacidade (shard atual até o teto, depois shard novo). A criação de sessão acontece no shard escolhido desde o início → **nenhuma migração de creds**.
4. **Cada shard = container WAHA com volume nomeado próprio** (ex.: `automacoes_waha_sessions_1`). A imagem é a mesma já no host (sem `docker pull`). Webhook de cada shard aponta para a mesma API (`/webhooks/waha`), que já distingue por `session`.

### Por que NÃO mover sessões existentes

O ganho de "rebalancear" não compensa o risco de re-pareamento de cliente pagante com imagem congelada (sem caminho de migração suportado). A capacidade extra vem de **clientes novos irem para shards novos**, não de mexer nos antigos. Blast radius da janela de manutenção também melhora naturalmente: uma manutenção no shard 1 não afeta o shard 0 (Cirilo/Samuel/Lola). Para o shard 0 a janela continua sendo a de hoje (01-05h BRT) — mas com menos sessões competindo por ele à medida que clientes novos vão para outros shards.

---

## Alternativas consideradas

### Opção A — Shard aditivo por colocação; só clientes novos em shards novos; existentes intocados ← **ESCOLHIDA**
- **Pros:** zero risco de re-pareamento (nenhuma sessão movida); imagem congelada respeitada (mesma imagem, container novo); blast radius reduzido (shards independentes); capacidade cresce horizontalmente; reversível (derrubar shard novo não afeta shard 0).
- **Contras:** não rebalanceia carga dos clientes antigos (shard 0 mantém seu conjunto); roteamento por shard é código novo na camada de integração + um registro de shard por sessão.
- **Escolhida porque:** é a única opção que respeita a constraint dura (zero re-pareamento) e ainda entrega capacidade + blast radius.

### Opção B — Migrar sessões para distribuir uniformemente entre shards
- **Pros:** balanceamento "limpo".
- **Contras:** mover `/app/.sessions/noweb/<sessao>` entre volumes/containers com imagem congelada = **risco direto de re-pareamento** do Cirilo/Samuel/Lola. Sem caminho de migração suportado pela imagem doada.
- **Descartada porque:** viola a constraint dura inegociável do Bruno. Risco inaceitável para cliente pagante.

### Opção C — Escalar verticalmente o container único (mais CPU/RAM)
- **Pros:** zero código; sem roteamento por shard.
- **Contras:** VPS é 2 vCPU / 7.8 GiB sem swap (Bruno não quer swap — memória `feedback_decisao_sem_swap`); teto físico próximo; **não reduz blast radius** (1 container = 1 ponto de falha para todos os clientes); manutenção continua derrubando todo mundo junto.
- **Descartada porque:** não resolve blast radius (o ganho que o Bruno citou) e esbarra no teto da VPS.

### Opção D — Um container WAHA por cliente (isolamento físico total)
- **Pros:** isolamento máximo; manutenção 100% por cliente.
- **Contras:** N containers WAHA = N × footprint de memória; estoura a VPS rapidamente (cada NOWEB segura estado); operacionalmente pesado (N webhooks, N healthchecks). Para o volume atual é exagero.
- **Descartada porque:** custo de RAM/operacional desproporcional ao volume. O sharding por grupos (Opção A, ~10-15 sessões por shard) dá blast radius suficiente sem explodir o footprint. Pode evoluir para "por cliente" para contas premium num ADR futuro.

---

## Consequências

### Positivas
- Capacidade horizontal: clientes novos vão para shards novos sem tocar nos antigos.
- Blast radius reduzido: manutenção/falha de um shard não derruba os demais. Cirilo/Samuel/Lola (shard 0) ficam isolados de incidentes em shards de clientes novos.
- Imagem congelada respeitada (mesma imagem, container adicional).
- Zero re-pareamento dos bots no ar — atende a constraint dura.
- Combina com ADR 0018: `tenant_id`/`flow_clones` é o lugar natural para registrar o shard.

### Negativas / trade-offs
- Roteamento por shard é código novo na camada de integração WAHA (hoje base URL único). Risco de bug de roteamento = mensagem para o shard errado. Default shard 0 mitiga (tudo que existe continua igual).
- Operação fica multi-container: mais healthchecks, mais webhooks, monitoramento por shard (a empresa ainda não tem observabilidade instalada — registrar como dependência).
- Shard 0 não rebalanceia: se um cliente antigo crescer muito, ainda compete no shard 0. Aceitável no volume atual.

### Neutras
- Esta é uma mudança de **infra + integração**, não de WAHA em si. A API já distingue sessões; só falta mapear sessão → endpoint.

---

## Plano de migração (incremental, reversível, SEM tocar sessões no ar)

### Passo 0 — Pré-requisitos e decisão de capacidade — **seguro online**
- Confirmar com `devops-sre`: footprint de RAM de um 2º container WAHA na VPS (2 vCPU / 7.8 GiB sem swap). Definir teto por shard (proposto: ~10-12 sessões/shard para folga).
- Confirmar que a imagem congelada está no host e que subir container novo **reusa a imagem local** (sem `docker pull`).
- **Gate de risco:** BAIXO (só análise). **Apetite:** 0.5 dia (`devops-sre` + `arquiteto`).

### Passo 1 — Registro de shard por sessão (default shard 0) — **seguro online**
- Migration aditiva (próximo número livre após 045/ADR 0018): `flow_clones.waha_shard_id INT NOT NULL DEFAULT 0` (ou tabela `waha_shards`). Todas as sessões existentes = shard 0.
- **Por que seguro:** aditivo, default = comportamento atual. Ninguém lê ainda.
- **Validação:** `SELECT waha_sessao, waha_shard_id FROM flow_clones;` → todos shard 0.
- **Rollback:** `DROP COLUMN`. **Apetite:** 0.5 dia (`backend-senior`).

### Passo 2 — Roteamento por shard na integração WAHA (flag `WAHA_SHARDING`, mapa só com shard 0) — **seguro online**
- `@startap/integrations` resolve endpoint por shard. Config de shards (ex.: `WAHA_SHARD_0_URL`, `WAHA_SHARD_1_URL`) com fallback: shard desconhecido/flag OFF → URL atual (shard 0). Com só shard 0 mapeado, comportamento é **idêntico** ao de hoje.
- **Gate de risco:** MÉDIO (toca o caminho de envio/download de mídia — caminho quente). Mas com mapa só de shard 0, é equivalência funcional.
- **Validação em prod SEM tocar sessões:** flag ON com só shard 0 → enviar/receber pela sessão de teste; confirmar que vai/volta do mesmo endpoint de sempre. Cirilo/Samuel/Lola continuam no shard 0, intocados.
- **Rollback:** flag OFF (volta ao base URL único).
- **Apetite:** 2 dias (`backend-senior` + `waha-specialist`).

### Passo 3 — Subir `automacoes-waha-2` (shard 1) VAZIO — **exige confirmação Bruno (container novo); NÃO toca shard 0**
- `devops-sre` sobe um 2º container WAHA com a MESMA imagem congelada, volume novo `automacoes_waha_sessions_1`, porta interna própria, webhook → mesma API. **Zero sessão** dentro dele inicialmente.
- **Por que não toca os bots no ar:** shard 0 (`automacoes-waha-1`) não é reiniciado nem alterado. O container novo nasce vazio.
- **Gate de risco:** MÉDIO (novo container consome RAM da VPS — validar footprint do passo 0). NÃO há risco de re-pareamento (nenhuma sessão existente envolvida).
- **Validação:** `automacoes-waha-2` healthy; shard 0 intacto (sessões de Cirilo/Samuel/Lola WORKING, sem reconexão); RAM da VPS dentro do limite.
- **Rollback:** derrubar `automacoes-waha-2` (vazio → sem perda).
- **Apetite:** 1 dia (`devops-sre`).

### Passo 4 — Provisionar o PRÓXIMO cliente novo no shard 1 — **seguro (cliente novo, sem sessão prévia)**
- O onboarding do próximo cliente cria a sessão JÁ no shard 1 (`flow_clones.waha_shard_id = 1`). Cliente novo escaneia o QR no shard 1 desde o início → **nenhuma migração de creds**.
- **Validação:** cliente novo pareia e responde via shard 1; Cirilo/Samuel/Lola seguem no shard 0 sem qualquer efeito.
- **Rollback:** se der errado com o cliente novo, é um cliente sem dependência histórica — recriar a sessão (no shard 0 ou 1) é o fluxo normal de onboarding.
- **Apetite:** dentro do onboarding normal (`waha-specialist` + `devops-sre`).

### Passo 5 (NÃO neste rollout) — Migração de sessão existente entre shards
- Só se algum dia for inevitável: janela 01-05h BRT, número a número, **com o cliente avisado e disponível para reparear**, backup do volume antes. **Decisão explícita do Bruno caso a caso.** Não é parte deste rollout e o design não depende disso.

---

## Validação (DoD deste ADR)
- Shard 0 (`automacoes-waha-1`) nunca é reiniciado nem alterado durante os passos 1-4. Cirilo/Samuel/Lola permanecem WORKING, **zero reconexão, zero QR novo**.
- Migration de `waha_shard_id` idempotente; todas as sessões existentes em shard 0.
- Com `WAHA_SHARDING` ON e mapa só de shard 0: envio/recebimento idêntico ao de hoje (sessão de teste).
- `automacoes-waha-2` sobe vazio, healthy, sem `docker pull`; RAM da VPS dentro do teto.
- Próximo cliente novo pareia no shard 1 e responde; nenhum efeito no shard 0.

## Rollback
- Passos 1-2: migration aditiva reversível + flag OFF.
- Passo 3: derrubar o container vazio (sem perda).
- Passo 4: cliente novo segue o fluxo normal de recriação de sessão.
- Em nenhum momento o shard 0 (bots no ar) é tocado → rollback nunca envolve re-pareamento de cliente existente.

## O que precisa de decisão/aprovação do Bruno
1. **Aprovar a hipótese confirmada:** shard só para clientes NOVOS; existentes ficam no shard 0; nenhuma sessão é movida neste rollout. (Recomendação: aprovar.)
2. **Subir um 2º container WAHA** (`automacoes-waha-2`) — consome RAM da VPS sem swap. Decisão de capacidade (Bruno + `devops-sre` + `financeiro` se exigir upgrade de VPS).
3. **Teto por shard** (proposto ~10-12 sessões) e quando começar a alocar clientes novos no shard 1.
4. Confirmar que **observabilidade por shard** (Prometheus/Grafana — ainda não instalado) deve preceder o scale-out real (recomendação do arquiteto: sim, pelo menos um healthcheck por shard).
5. Qualquer migração de sessão existente (passo 5) é decisão caso a caso, fora deste rollout.

## Referências
- Servidor confirmado (2026-06-12): 1 container WAHA, volume `automacoes_waha_sessions`, creds NOWEB em `/app/.sessions/noweb/<sessao>/`.
- `apps/api/src/registry.ts` — `findBotBySession`, mapa sessão→bot.
- `flow_clones.waha_sessao` — mapeamento slot→sessão (lugar do `waha_shard_id`).
- `@startap/integrations` (waha) — base URL único hoje (alvo do roteamento por shard).
- Memórias: `feedback_waha_imagem_congelada` (nunca `docker pull`), `reference_waha_sessao_lifecycle` (estados/re-pareamento), `feedback_decisao_sem_swap` (RAM sem swap), `feedback_padrao_sessao_waha_nova` (padrão de sessão nova).
- ADR 0018 — `tenant_id`/`flow_clones` como lugar de registro do shard.
- ADR 0019 — idempotência (pré-requisito de N instâncias da API que falam com N shards).
