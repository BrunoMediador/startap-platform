# Bot-detect — Spec de sinais (SCRUM-4)

> **Escopo desta spec:** detectar quando **outra empresa/bot** (não um cliente humano)
> está conversando com o nosso bot, inclusive quando o "outro lado" imita ritmo humano
> (1–2 mensagens por turno). O objetivo é **marcar o número como bot** sem nunca pausar
> um cliente real por engano.
>
> **Esta PR é só design.** Nada aqui chama LLM em runtime nem implementa o job. PR-C
> implementa o pipeline no worker; PR-D roda a eval contra o classificador.

## Princípio de decisão (regra dura)

**Nunca decidir por 1 sinal isolado.** Marca-se como bot apenas se:

- **≥ 2 sinais ORTOGONAIS** dispararem (ver eixos abaixo), **OU**
- o **LLM** (prompt `prompts/bot-detect/v1.md`) retornar `is_bot=true` com `confidence ≥ 0.85`.

"Ortogonal" = de **eixos diferentes**. Dois sinais do mesmo eixo (ex.: cadência regular +
instantaneidade — ambos de *timing*) são correlacionados e **contam como 1**.

| Eixo | Sinais |
|---|---|
| **A. Timing** | flood, cadência regular / baixo jitter, instantaneidade consistente |
| **B. Endereçamento** | `@lid`, broadcast, `@g.us` (grupo) |
| **C. Conteúdo** | templated repetido / formatação de marketing, `pushName` = marca |
| **D. Mutualidade** | eco bot↔bot |

Default em dúvida = **humano** (não marcar). Falso-negativo (deixar um bot passar) é
barato; falso-positivo (marcar um cliente real) é caro.

## Fontes de dados

| Fonte | Tabela / campo | Conteúdo |
|---|---|---|
| **Cadência (24h)** | `message_log (phone, chat_id, created_at)` | 1 linha por mensagem **recebida**. `chat_id` = **nome da sessão WAHA** (não o JID). `pruneOldLogs` mantém ~24h → janela de cadência é **no máximo 24h**. |
| **Conteúdo** | `chat_histories*` `(id, session_id, message JSONB)` | `message = {type:'human'\|'ai'\|'system', data:{content}}`. **Só `type='human'`** = mensagens do número analisado; `type='ai'` = respostas do NOSSO bot. `session_id` = `${slot}:${sessao}:${flowId}:${telefone}` → **termina em `:<telefone>`** (filtrar por `session_id LIKE '%:'||telefone`). |
| **Endereçamento / pushName** | payload WAHA na ingestão (`payload.from`, `payload._data.key.addressingMode`, `payload._data.notifyName`/contatos) | **Não persistido** hoje em `message_log`/`chat_histories`. PR-C precisa capturar/persistir (ver "Dependências de dados"). |

### Dependências de dados (para PR-C)

1. **Timestamps de saída (`ai`) não existem.** `message_log` só registra mensagens
   recebidas; `chat_histories` não tem `created_at`. Logo, **latência de resposta ao
   nosso bot** (instantaneidade / eco) **não é mensurável** com o schema atual. PR-C deve
   ou (a) adicionar `created_at` a `chat_histories`, ou (b) usar `flow_execution_log` para
   parear envio→resposta. Até lá, instantaneidade roda em **modo aproximado** (ver sinal 3).
2. **`addressingMode` / `pushName` / JID bruto** não são persistidos. PR-C deve gravá-los
   (coluna nova em `message_log` ou tabela `number_signals`) no momento da ingestão para o
   job poder lê-los 1x por número novo.

## Sinais

Legenda: **Custo** = barato (SQL/regex puro) vs caro (precisa pareamento/timestamps novos).
**Poder** = discriminante (quanto separa bot de humano).

### 1. Flood (burst)

- **O quê:** muitas mensagens em poucos segundos (já coberto pelo antibot: 6 msgs / 60s).
- **Como medir:** `findSuspects(6, 60)` em `message_log` (já existe). Reusar como sinal.
- **Threshold sugerido:** ≥ 6 msgs / 60s (alinhado ao antibot).
- **Custo:** barato. **Poder:** alto — para o bot **barulhento**; cobre população diferente
  da do bot "ritmo humano" (alvo principal do SCRUM-4).
- **Eixo:** A (Timing).
- **Falso-positivo:** cliente ansioso mandando "oi? oi? tem horario? alo?" em rajada.
  **Mitigação:** nunca decidir só por flood; exigir 2º eixo (ex.: conteúdo templated ou
  endereçamento). Flood já tem o tratamento separado do antibot (pausa temporária), que é
  reversível.

### 2. Cadência regular / baixo jitter

- **O quê:** intervalos entre mensagens quase constantes (máquina) vs. irregulares (humano).
- **Como medir:** deltas de `created_at` consecutivos por `phone` em `message_log` (24h);
  coeficiente de variação `CV = desvio/μ` sobre **≥ 5 intervalos**.
- **Threshold sugerido:** `CV < 0.15` com **≥ 5 intervalos** (≥ 6 mensagens) → suspeito.
- **Custo:** barato. **Poder:** alto **se** houver volume; fraco em conversas curtas.
- **Eixo:** A (Timing).
- **Falso-positivo:** humano pode parecer regular em janela curta/coincidência; mensagens
  agrupadas pelo WAHA podem distorcer deltas. **Mitigação:** mínimo de 5 intervalos;
  ignorar deltas < 1s (mensagens "quebradas"); exigir 2º eixo.

### 3. Instantaneidade consistente (≥ 5 turnos)

- **O quê:** o outro lado responde à NOSSA mensagem em < ~2s, de forma consistente, por
  ≥ 5 turnos (humano lê/digita → varia e demora mais).
- **Como medir:** parear cada saída `ai` → próxima entrada `human` e medir o gap.
  **⚠️ Não mensurável hoje** (sem timestamp de saída — ver Dependências). **Modo aproximado
  até PR-C:** usar regularidade extrema (sinal 2) como proxy e **NÃO** contar instantaneidade
  como eixo próprio enquanto o timestamp de saída não existir.
- **Threshold sugerido:** gap < 2s em ≥ 5 de N turnos (quando os timestamps existirem).
- **Custo:** caro (depende de schema novo). **Poder:** alto — discrimina bem "ritmo humano
  falso".
- **Eixo:** A (Timing).
- **Falso-positivo:** auto-reply / mensagens curtas digitadas rápido; relógios fora de sync.
  **Mitigação:** ≥ 5 turnos; exigir 2º eixo; tolerância de clock.

### 4. Endereçamento: `@lid` / broadcast / `@g.us`

- **O quê:** o número alcançou o bot por canal atípico de cliente real.
- **Como medir:** `payload.from` / `addressingMode` na ingestão (persistir — Dependência 2).
  Grupo (`@g.us`, JID `120363…`, campo `participant`) **já é ignorado** pelo router.
- **Threshold sugerido:** broadcast (`status@broadcast`) ou grupo → sinal **forte**;
  `@lid` **isolado** → sinal **fraco**.
- **Custo:** barato. **Poder:** broadcast/grupo = muito alto; `lid` = baixo.
- **Eixo:** B (Endereçamento).
- **Falso-positivo:** **`@lid` é legítimo** para usuários reais com privacidade do WhatsApp
  — `lid` sozinho **nunca** marca bot. **Mitigação:** tratar `lid` só como reforço fraco;
  broadcast/grupo já são fortes mas ainda exigem 2º eixo pela regra dura.

### 5. Conteúdo templated repetido / formatação de marketing

- **O quê:** texto idêntico repetido (entre números ou no mesmo fio) e/ou formatação de
  campanha: `*negrito*`, blocos de emoji, links, "Junte-se", "PROMO", "CLIQUE", CTA.
- **Como medir:** `chat_histories` (`type='human'`): hash/normalização do conteúdo para
  detectar repetição verbatim; regex de marcadores de marketing (`*...*`, `http`, emojis em
  bloco, ALLCAPS longo, "promo|sorteio|ganhe|clique|junte-se|tiktok|telegram").
- **Threshold sugerido:** mesmo texto normalizado ≥ 2 ocorrências **OU** ≥ 2 marcadores de
  marketing numa mensagem.
- **Custo:** barato. **Poder:** alto para blast de marketing.
- **Eixo:** C (Conteúdo).
- **Falso-positivo:** cliente real **encaminha** uma promo uma vez; copia/cola um endereço.
  **Mitigação:** exigir repetição **ou** combinar com 2º eixo; peso menor para 1 link
  isolado.

### 6. `pushName` = marca (não nome de pessoa)

- **O quê:** o `pushName` parece nome de negócio/campanha ("SUPER PROMOÇÕES", "Loja X
  Oficial", emoji no nome, ALLCAPS) em vez de nome de pessoa.
- **Como medir:** heurística sobre `pushName` (persistido pela Dependência 2): emoji,
  ALLCAPS, termos de marca/CTA, ausência de padrão de nome próprio PT-BR.
- **Threshold sugerido:** match de marca → sinal **médio**.
- **Custo:** barato. **Poder:** médio.
- **Eixo:** C (Conteúdo).
- **Falso-positivo:** o `pushName` é editável pelo usuário; gente real usa apelido/emoji.
  **Mitigação:** nunca isolado; só reforça outro eixo.

### 7. Mutualidade / eco bot↔bot

- **O quê:** os dois lados respondem na hora, em lockstep, sem pausa humana, por uma
  sequência longa — sintoma de bot conversando com bot.
- **Como medir:** combinação de instantaneidade (sinal 3) **dos dois lados** + cadência
  regular (sinal 2) + sequência longa ininterrupta. **⚠️ Depende dos timestamps de saída**
  (Dependência 1) — não mensurável hoje.
- **Threshold sugerido:** instantaneidade bilateral por ≥ 5 turnos.
- **Custo:** caro. **Poder:** alto quando presente, mas **raro**.
- **Eixo:** D (Mutualidade).
- **Falso-positivo:** baixo. **Mitigação:** ainda assim, exigir confirmação por conteúdo ou
  endereçamento quando possível.

## Pipeline híbrido (heurística → LLM só na zona-cinza)

Roda **1× por número novo**, no **worker**, com **cache** do veredito por telefone canônico
(`canonicalE164`). Não roda no caminho de resposta do bot (não adiciona latência ao cliente).

```
1. Coleta barata (SQL/regex): sinais 1,2,4,5,6 do número.
2. Pontua por eixo.
   - ≥ 2 eixos fortes (ex.: broadcast + templated)        → BOT  (skip LLM)
   - sinais claros de humano (curto, gíria/erro PT,
     pushName de pessoa, cadência irregular, sem marca)   → HUMANO (skip LLM)
   - caso contrário                                        → ZONA-CINZA
3. Zona-cinza: chama o LLM (v1) com as últimas N msgs `human`.
   - is_bot=true & confidence ≥ 0.85                       → BOT
   - senão                                                  → HUMANO (default seguro)
4. Cacheia o veredito (+ razão + sinais) por telefone canônico.
```

**Observabilidade (PR-C):** por execução logar `phone`(mascarado), `verdict`, `signals`,
`used_llm`, e — se usou LLM — `model`, `input_tokens`, `output_tokens`, `latency_ms`,
`confidence`. Custo é input-dominado; só a zona-cinza paga LLM.

**Reversibilidade:** marcar como bot **não pausa cliente real**; é um rótulo no número.
Deve haver caminho de revisão/whitelist — ver "Escalação e controle do cliente" abaixo.

---

## Escalação automática e controle do cliente (fase PR-E)

> Requisito de produto (Bruno). **Não muda os sinais nem a eval suite** — é a camada de
> AÇÃO que consome o veredito da detecção. Documentado aqui para o PR-E implementar.
> **Tudo gated por flag + por clone** (mesmo padrão de `ATEND_FROM_AGENDA_SLOTS`): clone
> fora da lista = comportamento atual (nada pausa). Default = OFF.

### Princípio

O alerta ao dono **não é beco sem saída**. Se o dono não reage e o bot suspeito não para,
o sistema **pausa automaticamente** — mas a pausa é **sempre reversível pelo próprio
cliente** no portal. É o despausar self-service que torna a auto-pausa **segura e aceitável**
(o pior caso, um falso-positivo, é desfeito pelo cliente em 1 clique, sem suporte).

### Gatilho de auto-pausa (as 3 condições, todas necessárias)

Após o número ser classificado bot **e** o dono ter sido alertado, auto-pausa **só** dispara se:

- **(a) Dono inerte** — sem resposta/interação com o alerta (não despausou, não respondeu,
  não fez whitelist) dentro da janela.
- **(b) Número não parou** — continuou enviando mensagens depois do alerta (há atividade
  nova em `message_log` após `alerted_at`).
- **(c) Ainda classifica como bot** — re-rodar a detecção ao fim da carência mantém o
  veredito bot (≥ 2 eixos OU LLM `confidence ≥ 0.85`). Não basta o veredito antigo.

**Janela de carência** = configurável (env por clone, ex.: `BOT_DETECT_GRACE_MINUTES`,
default sugerido 60 min). Vazio/0 = nunca auto-pausa (só alerta).

### Máquina de estados

```
              detecção (bot)            alerta ao dono            carência expira
                                                              + (a)∧(b)∧(c) true
  suspeito ───────────────► alertado ──────────────► (carência) ─────────────► auto_pausado
     │                          │                                                    │
     │ veredito vira humano     │ dono despausa / whitelist / número para            │ cliente despausa
     │ (re-detecção)            ▼                                                    ▼  (portal → removeFlowPause)
     └─────────────────────► (encerrado / humano)  ◄──────────────────────────── despausado
```

- **suspeito** — detecção rodou e deu bot; ainda nada feito.
- **alertado** — alerta enviado ao dono (via ALERTAS); carimba `alerted_at`. Início da carência.
- **(carência)** — janela aberta; ao expirar, avalia (a)∧(b)∧(c).
  - condições falsas (dono agiu, ou número parou, ou re-detecção virou humano) → **encerrado**.
  - condições verdadeiras → **auto_pausado**.
- **auto_pausado** — `addFlowPause({source:'bot_detected'})` no clone. Número entra na lista
  do portal. Bot para de responder àquele número.
- **despausado** — dono ou cliente removeu (`removeFlowPause`, `active=FALSE`); volta a
  responder. Re-detecção futura pode reabrir o ciclo (com cooldown para não re-pausar em loop).

Transições idempotentes; o estado deriva de `flow_pauses` (`source`, `active`) + carimbos
(`alerted_at`, etc., em tabela de controle do PR-E). Sem cron de "des-alerta": o
encerramento é avaliado na expiração da carência.

### Reuso de primitivas existentes (não reinventar)

A pausa **reusa o `flow_pauses`** já em produção — só muda o `source`:

- **Pausar:** `addFlowPause({ flowId: slot, telefone, session, source: 'bot_detected', reason })`
  (`packages/db/src/queries/pausa.ts`). Aparece junto das pausas manuais/antibot.
- **Listar:** `listFlowPauses(flowId)` / `portalConfig.listPausasBySlot(slot)` — já escopado
  por clone, já usado por `GET /portal/pausas`.
- **Despausar:** `removeFlowPause({ flowId, telefone, source:'bot_detected' })` — já exposto
  por `DELETE /portal/pausas/:telefone` (escopo `withTenant`, telefone 10–15 dígitos validado,
  log mascarado). **O dono já pode despausar qualquer pausa do próprio fluxo** — `bot_detected`
  entra nesse mesmo fluxo, sem rota nova.

### UI no portal (controle do cliente)

Reusa a tela de pausas que já existe (`apps/portal-web/src/lib/bot-pausa.ts` + rota
`/portal/pausas`), apenas **diferenciando a origem** pelo `source`:

- Lista de números pausados do clone, com **badge por origem**: `manual` (dono pausou),
  `antibot` (flood), e **novo `bot_detected` ("Detectado como bot")**.
- Para `bot_detected`, mostrar a **razão** (`reason`: sinais que dispararam / "LLM
  confiança 0.9") para o cliente entender por que foi pausado.
- Botão **"Despausar / É cliente real"** → `DELETE /portal/pausas/:telefone` → `removeFlowPause`.
  Idêntico ao despausar manual de hoje (mesmo endpoint, mesmo controle de tenant).
- Opcional (PR-E decide): "Despausar e não detectar de novo" = despausar + whitelist do
  número (evita o ciclo reabrir).

Telefone **mascarado** em log (LGPD), igual ao resto do portal. Nada disso adiciona PII
nova — o número já transita no fluxo de pausas atual.

### Segurança / isolamento

- Auto-pausa **nunca** afeta clone fora da flag/lista (kill-switch = limpar a env, sem deploy).
- `withTenant` garante que um clone só vê/despausa pausas do **próprio** `flow_id` (anti-IDOR
  já existente nas rotas de pausa).
- Falso-positivo é **contido por design**: cliente despausa sozinho; nenhuma ação destrutiva,
  nenhuma mensagem perdida (pausa só silencia o bot para aquele número, reversível).
