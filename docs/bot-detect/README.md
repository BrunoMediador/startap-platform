# bot-detect (SCRUM-4) — artefatos de design

Detectar quando **outro bot/empresa** (não um cliente humano) conversa com o nosso bot —
inclusive quando imita ritmo humano (1–2 msgs por turno) — e **marcar o número como bot
sem nunca pausar um cliente real**.

A detecção é **híbrida**: heurística barata primeiro, LLM só na **zona-cinza**, **1× por
número novo** com **cache**, rodando no **worker**.

> ⚠️ **Esta PR (PR-B) é só design/artefato.** Não implementa o job, não chama LLM em
> runtime, não faz deploy. Entrega o material que PR-C/PR-D/PR-E consomem.

## Conteúdo

| Arquivo | O que é |
|---|---|
| [`sinais.md`](./sinais.md) | Spec dos 7 sinais (como medir / threshold / custo / poder / falso-positivo + mitigação), a regra dura (≥2 eixos ortogonais OU LLM ≥0.85), o pipeline híbrido, e a **escalação automática + controle do cliente** (fase PR-E). |
| [`../../prompts/bot-detect/v1.md`](../../prompts/bot-detect/v1.md) | Prompt versionado v1: persona-free, temperatura 0, entrada = últimas N msgs `human`, saída JSON `{is_bot, confidence, reason}` + **zod schema** (doc, não fiado) + changelog. |
| [`eval-cases.jsonl`](./eval-cases.jsonl) | 48 casos rotulados cliente-real vs bot, no estilo real da base (gíria/erro PT, áudio, `pushName` de pessoa vs marca, broadcast/lid, templated/formatação). Cada caso: `id`, `label`, `messages`, `why`, e opcionais `pushName`/`addressing`/`signals`. |
| [`eval-cases.test.ts`](./eval-cases.test.ts) | Vitest puro: valida só a **forma/labels** dos fixtures (sem chamar API). |

## Como medir (resumo das fontes)

- **Cadência (24h):** `message_log (phone, chat_id, created_at)` — `chat_id` = nome da sessão WAHA.
- **Conteúdo:** `chat_histories*` `(session_id, message JSONB)`, só `type='human'`;
  `session_id` **termina em `:<telefone>`**.
- **Endereçamento / pushName:** payload WAHA na ingestão (precisa ser persistido — ver
  "Dependências de dados" em `sinais.md`).

## Como PR-C / PR-D / PR-E consomem

- **PR-C (job no worker):** implementa o pipeline de `sinais.md` (coleta barata → pontua por
  eixo → zona-cinza chama o prompt `v1.md` → valida com o zod schema → cacheia por telefone
  canônico). Observabilidade e padrões (timeout/retry/fallback) conforme `v1.md`.
- **PR-D (eval real):** roda os casos de `eval-cases.jsonl` **contra o classificador** e mede
  precisão/recall (alvo: recall alto em bot, **falso-positivo de humano ~0**). O
  `eval-cases.test.ts` aqui só garante que os fixtures estão bem-formados.
- **PR-E (ação/escalação):** consome o veredito — alerta o dono, e (gated por flag/clone)
  **auto-pausa** após carência se o dono ficar inerte E o número não parar E ainda
  classificar bot; o número pausado entra na **lista do portal** com badge `bot_detected` e o
  cliente pode **despausar** (`removeFlowPause`) num clique. Detalhe em `sinais.md` →
  "Escalação automática e controle do cliente".

## Rodar o teste de fixtures

```bash
npx vitest run docs/bot-detect/eval-cases.test.ts
```
