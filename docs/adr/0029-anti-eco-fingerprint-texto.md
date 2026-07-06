# ADR 0029 — Anti-eco por fingerprint de TEXTO (distinguir eco-do-app de resposta humana)

- **Status:** ACEITO (aprovado em review 2026-07-05)
- **Data:** 2026-07-05
- **Autor:** 02-backend-senior
- **Aprovado por:** PM (bridge do arquiteto) — review da PR #426
- **DRI:** 02-backend-senior
- **Cards:** SCRUM-59 (mesmo número IA + atendente), SCRUM-60 (este ADR)
- **Relacionados:** ADR 0019 (idempotência/lock Redis — mesmo primitivo `SET ... EX`), SCRUM-57 (upgrade da imagem WAHA — **gatilho de revisão deste ADR**), PR #426.
- **Escopo:** nano-ADR de UM mecanismo (não do feature inteiro — o feature é código aditivo gated por-clone com caminho byte-idêntico fora do gate, dispensa ADR próprio).

---

## Contexto

No modo atendente ("mesmo número"), a recepção responde À MÃO pelo WhatsApp da própria barbearia. Uma resposta humana à mão deve **pausar** o bot naquele contato (com TTL, ver `flow_pauses.expires_at`); uma frase-chave humana (ex.: "atendente aqui!!") deve **comandar** pausa/retomada. Ambos os gatilhos leem mensagens **fromMe** no webhook.

**O problema:** o próprio bot também gera fromMe. A resposta que o bot envia via WAHA volta no webhook como `fromMe=true` (eco). Se qualquer fromMe disparasse a auto-pausa, **o bot se auto-pausaria após cada resposta**. É obrigatório distinguir "app enviou via API" de "humano digitou no aparelho".

**A constraint frágil:** a imagem WAHA está **congelada (engine NOWEB)**. Não há garantia de que o `message.id` retornado pelo `sendText` seja **idêntico** ao `payload.id` do eco no webhook (formatos/`_serialized` variam por engine/versão). Também não há campo de payload documentado e estável (`source`/`deviceSentMeta`) que marque "enviado por API" nessa imagem. Ou seja: **não dá pra confiar no id pra reconhecer o eco hoje.**

---

## Decisão

Reconhecer o eco por **fingerprint de TEXTO normalizado**, não por id:

1. Ao enviar a resposta (chokepoint `base.ts`), grava uma marca no **Redis**: chave `bot-echo:<session>:<telefone>:<sha1(texto_normalizado)>`, valor `1`, **TTL 5 min** (`SET ... EX`, best-effort, nunca lança). Só para clones no gate `MODO_ATENDENTE_SLOTS`.
2. No ramo fromMe do router, o webhook cujo texto bate na marca = **eco do bot** → pula keyword-match E não auto-pausa. Sem marca = **humano**.
3. **Fonte de verdade única:** a normalização do fingerprint e a do `keyword_norm` são a MESMA função canônica (`@startap/core/normalizePauseKeyword`) — o mesmo anti-eco protege os dois gatilhos.
4. **Fail-safe (lado seguro = nunca calar o bot):** Redis indisponível → estado `degraded` → **NÃO auto-pausa** (o keyword-match, que é comando humano explícito, ainda roda). Na dúvida, o bot segue respondendo — jamais se auto-silencia.

Por que texto funciona onde o id não: o eco do WhatsApp carrega o **texto verbatim** do que foi enviado; a normalização (trim + colapsa espaço + minúsculas) absorve diferenças triviais. E o `telefone` extraído é o mesmo do envio (é o remoteJid da conversa, não o número próprio) — provado pelo fato de a pausa-por-keyword já funcionar hoje sobre fromMe.

---

## Alternativas rejeitadas

1. **Rastrear `message.id` (envio ↔ eco).** Mais preciso EM TESE, mas **instável na imagem WAHA congelada (NOWEB)**: sem garantia de que o id do `sendText` == `payload.id` do eco. Se divergir, o eco nunca é reconhecido → bot se auto-pausa a cada resposta. Rejeitado enquanto a imagem for a congelada — **reabre no SCRUM-57** (ver gatilho abaixo).
2. **TTL da pausa configurável por-clone.** Fixo em **60 min renovável** (cada resposta humana renova). Config por-clone é escopo v2; hoje adicionaria superfície sem demanda.
3. **Cron de expiração das pausas.** Preferido: **leitura lazy** via `expires_at` no `isFlowPaused` (`active AND (expires_at IS NULL OR expires_at > NOW())`). Menos peça móvel, sem job pra falhar; linhas expiradas ficam inertes (ou um cleanup oportunista futuro, sem urgência).

---

## Consequências

**Positivas**
- Robusto à instabilidade do `message.id` na imagem congelada — não depende de campo interno não-documentado da engine.
- Reversível/desligável na hora pelo gate CSV `MODO_ATENDENTE_SLOTS` (fora do gate, nem toca Redis; caminho byte-idêntico).
- Um só anti-eco cobre auto-pausa e keyword-match (fonte de verdade única, sem drift).
- Fail-safe explícito: falha de Redis degrada pro lado seguro (bot nunca se cala sozinho).

**Negativas / trade-offs**
- **Falso-negativo raro:** se um humano digitar um texto IDÊNTICO ao que o bot acabou de enviar, na MESMA conversa, dentro da janela de 5 min, é tratado como eco → aquela mensagem não pausa. Degrada pro lado seguro (bot só deixa de pausar uma vez; a próxima resposta humana pausa). Aceito.
- Telefone em claro na chave Redis (TTL 5 min) — consistente com `flow_pauses` (telefone cleartext no PG); hashear o segmento é follow-up trivial se o security pedir.

**⚠️ Gatilho de revisão — fechamento do SCRUM-57 (upgrade da imagem WAHA).**
Se o upgrade entregar `message.id` **estável** (envio == eco) e/ou um campo de payload confiável que marque "enviado por API", migrar o anti-eco pra id fica **mais barato e preciso** que o fingerprint de texto (elimina o falso-negativo). **NÃO "consertar" pra `message.id` antes do SCRUM-57 fechar e o id ser verificado estável nessa imagem** — fazer isso na imagem atual reintroduz o auto-pause do próprio bot. Este ADR é o registro do "por quê" pra um dev futuro não regredir sem querer.

---

## Referências
- `apps/api/src/lib/human-reply-pause.ts` — `registerBotReplyEcho` / `isBotEcho` (echo|human|degraded) / `isSelfChat`.
- `apps/api/src/bots/base.ts` — chokepoint que marca o eco após `sendText` (só clones no gate).
- `apps/api/src/router.ts` — ramo fromMe do modo atendente (self-chat → anti-eco → keyword → auto-pausa).
- `packages/core/src/pause-keyword.ts` — `normalizePauseKeyword` (fonte única do `keyword_norm` e do fingerprint).
- `packages/db/migrations/071_flow_pauses_expires_at.sql` — TTL da pausa (leitura lazy).
- ADR 0019 — idempotência/lock Redis (mesmo primitivo `SET ... EX`, fail-open/fail-safe).
- SCRUM-57 — upgrade da imagem WAHA (gatilho de revisão desta decisão).
