# ADR 0032 — Builder conversacional de persona (meta-agente que monta o bot_prompt)

- **Status:** Proposto (MVP implementado em `feat/scrum-92-prompt-builder`; aguarda review qa+security + GO do PM/Bruno pro deploy)
- **Data:** 2026-07-20
- **Autor:** 02-backend-senior
- **SCRUM:** SCRUM-92
- **Relacionados:** SCRUM-59/83/84 (persona sticky / prompt_custom / emojis por área), ADR 0018 (dual-write tenant_id), ADR 0030 (produtização self-service / gate env→coluna), ADR 0012 (portal-api / sessão Redis). Padrão de código reusado: `apps/portal-api/src/routes/demo-chat.ts` (chat + runAgent + guards Redis).

---

## Contexto

Hoje a persona do bot é escrita à mão (gestão `PUT /api/bots/:slot/prompt`, SCRUM-83) ou re-renderizada do template da matriz. Para o self-service multi-segmento (Ingrid foi o 1º 100% self-service), o dono precisa conseguir dar "a cara do negócio" ao assistente SEM operador — mas sem poder de quebrar a mecânica de agendamento (cartão de confirmação + exigir "SIM" antes de `inserir_agendamento`), que é o coração do produto.

A solução é um **meta-agente entrevistador** (nosso, não o bot do cliente) que conduz 4-6 perguntas e PROPÕE a **persona** (voz/tom/nome/regras da casa). Dados operacionais (endereço/horário/serviço/preço) NUNCA entram no gerado — vêm de campos estruturados em runtime (`perfilSchema`, `flow_clones.horarios_funcionamento`, catálogo `servicos`) via `buildContextBlock`.

## Decisão

### 1. Garantia estrutural colada por CÓDIGO (append no MVP)

O meta-agente gera **somente a persona**. A garantia — cartão + exigir SIM — é o `BLOCO_ESTRUTURAL` (`packages/integrations/src/prompt-builder/bloco-estrutural.ts`), texto de **código**, colado pelo SERVIDOR **depois** da persona no `approve`:

```
finalPrompt = persona_validada + "\n\n" + buildBlocoEstrutural({ modo, area })
```

A IA nunca escreve a mecânica → nunca pode removê-la. Variante `agenda` (cartão + SIM, area-aware nos emojis) vs `atendente` (sem cartão; escala pra humano). Retrocompat: Cirilo/Samuel são `prompt_custom=false` e não rodam o builder → intocados byte-a-byte.

**Increment 2 (ADR-gated, fora deste MVP):** mover o cartão+SIM do `bot_prompt` (persona) pra bloco de código no `systemPrompt` de `teste_barbearia.ts` pra TODOS os clones = trava belt-and-suspenders real. Mexe no byte-a-byte de Cirilo/Samuel → refactor >300 linhas + regressão qa completa. O MVP NÃO toca aquele assembly.

### 2. Estado efêmero no Redis (NÃO banco)

A conversa é artefato descartável de onboarding, não system-of-record. Vive em `portal:promptbuilder:<slot>` (JSON `{turns, draft, modo, area, nomeNegocio}`), TTL sliding ~2h. Abandono se auto-limpa por TTL (sem cron). O ÚNICO artefato durável é o prompt **aprovado** — e esse cai no Postgres (`bot_prompt` + histórico versionado em `bot_prompt_versions`). Evita migration/tabela/cron. LGPD-friendly (transcrição não acumula). Se a key evict antes de aprovar, o dono re-roda (idempotente, barato).

### 3. Provider DeepSeek forçado (meta-agente ≠ bot do cliente)

O entrevistador roda SEMPRE no DeepSeek (`deepseek-chat`, `baseURL=https://api.deepseek.com/v1`, `apiKey=DEEPSEEK_API_KEY`) — **NÃO herda `bot_config` do clone** (que pode ser `gpt-5.4`). Custo ~US$0,01–0,05/onboarding (one-time), trivial ante os ~US$19–26/mês de IA. Capaz o suficiente pra boa UX.

### 4. Transação de approve única em `packages/db`

A receita transacional do SCRUM-83 (antes inline em `painel-admin/server.js` ~1267-1340) foi EXTRAÍDA pra `botPrompt.applyGeneratedPrompt(slot, finalPrompt, editedBy)`: `BEGIN` → snapshot pré-edição em `bot_prompt_versions` (comment `prompt-builder`, só se mudou) → upsert `bot_prompt` (dual-write tenant_id) → `UPDATE flow_clones.prompt_custom=true` → `COMMIT` → `invalidatePromptCache`. O `prompt_custom=true` (guard SCRUM-59/83) protege a persona gerada do re-render do perfil. Reusável por portal-api E gestão (increment).

### 5. Defesa em profundidade (segurança)

- **Isolamento de tenant:** `withTenant` é o chokepoint — slot só da sessão, nunca do body (anti-IDOR já provado).
- **Anti-injeção:** `systemPrompt` do entrevistador é FIXO no servidor; input do dono SEMPRE `role:user` (nunca concatenado ao system). `role != 'user'` no body → 400. O meta-agente só tem a tool `propor_prompt` (captura texto) — sem tool de leitura de banco → sem exfiltração.
- **Validador determinístico** (`prompt-builder-validator.ts`) roda sobre a persona ANTES de virar preview/persistir: remove linhas com CEP/telefone/moeda/horário/logradouro/e-mail/CPF, nomes de serviço do catálogo do clone, e tokens estruturais (cartão/SIM/`inserir_agendamento`/marcadores). `sanitizeOrphanPlaceholders` limpa `{var}` fora da whitelist. `stripPII` redige e-mail/CPF inline. Pior caso residual = info duplicada, nunca quebra do fluxo (o runtime é a autoridade dos dados operacionais).
- **Rate-limit/custo (Redis, fail-closed):** teto de turns/entrevista + msgs-dia/tenant + hard cap global diário (kill-switch). LGPD: nunca loga conteúdo (só slot/tokens/latency/blocked_reason).

### 6. Gate de rollout

Atrás da flag `PROMPT_BUILDER_ENABLED` (kill-switch de env; ausente = OFF → rotas 404). Decisão do Bruno: **subir ON pra todos** → o PM seta `PROMPT_BUILDER_ENABLED=true` no deploy (confirmar ON/OFF com o PM, lição feedback-perguntar-on-off-deploy). `DEEPSEEK_API_KEY` já existe em prod (usada pela demo/Lola); validada LAZY (rota 503 se faltar, boot não crasha — lição #247).

## Consequências

- **Positivo:** self-service de persona sem operador; garantia da mecânica à prova da IA; custo trivial; zero migration; transação de prompt unificada (portal + gestão consistentes).
- **Negativo / dívida aceita:** a trava REAL de execução (bloquear `inserir_agendamento` sem SIM no runtime) continua dívida separada (hoje é só instrução no prompt) — increment 2. Draft perdido em evict do Redis = re-roda (documentado). `bot_prompt_versions` é durável → persona não pode conter PII (strip no approve mitiga; documentado). Duplicação pequena e estável do mapa de emojis por área entre `apps/api/src/lib/area-emojis.ts` e o `bloco-estrutural.ts` (packages não importa de apps) — o increment 2 unifica; efeito de divergência é só cosmético.

## Alternativas descartadas

- **Estado da entrevista no Postgres:** overkill pra artefato descartável (migration + tabela + cron de limpeza). Redis+TTL resolve.
- **Persona incluir a mecânica (LLM escreve o cartão):** dá poder ao LLM de remover a garantia (injeção). Recusado — a garantia é código.
- **gpt-4o no entrevistador:** desnecessário (meta-agente não é customer-facing); DeepSeek entrega UX a 1/10 do custo.
- **Captura por bloco ```delimitado```:** frágil (o modelo esquece a cerca). Tool-call (`propor_prompt`) é campo estruturado e robusto.
