# ADR 0022: Transcrição de áudio via OpenAI (offload do Whisper local) + fix do medidor de custo

> **Quem escreve:** `ai-engineer` (desenho) — formaliza com `arquiteto`
> **Onde fica:** `docs/adr/0022-transcricao-via-openai.md`
> **Quando usar:** Mudança de pipeline de transcrição de áudio do WhatsApp. Remover o teto-duro de capacidade da VPS (Whisper local) e centralizar custo de transcrição na conta OpenAI do Bruno.

---

**Status:** proposta — aguardando aprovação de Bruno
**Data:** 2026-06-13
**Autor:** ai-engineer (desenho) / arquiteto (formalização)
**Aprovado por:** pendente
**Relacionados:** `docs/capacidade-vps-100-clientes.md` (Whisper local = gargalo nº1), ADR 0018 (tenant_id), ADR 0020 (shard WAHA), ADR 0021 (decouple webhook async). Lição do incidente #247 (env nova nunca derruba o boot).

> **Nota de numeração:** este ADR foi renumerado de `0021` → `0022` porque `0021` foi atribuído ao ADR de decouple async do webhook WAHA na mesma sessão (colisão resolvida pelo arquiteto).

---

## Contexto

Hoje o áudio do WhatsApp (voice notes OGG/opus) é transcrito pelo **Whisper LOCAL** (container `automacoes-whisper-1`, ASR REST em `:9000`, modelo `faster_whisper small`). Medições read-only (2026-06-13):

- **1.325 GiB de RAM residente fixa** (modelo carregado o tempo todo).
- **20–40s de 1 vCPU por áudio** de ~30s. Em 2 vCPU, 2 áudios simultâneos saturam ambos os cores — transcrição é **serial na prática**.
- É o **gargalo nº1 de capacidade**: satura em ~15–30 clientes (barbearia recebe muito áudio), antes de RAM/WAHA.

O Bruno autorizou **remover o Whisper local** e transcrever via OpenAI, usando a chave/SDK já configurados para o chat (`OPENAI_API_KEY`). Sem segredo novo.

Em paralelo, descobriu-se que `model_usage.cost_usd` **superestima ~70x** a conta real da OpenAI (Cirilo real ≈ US$0,20/mês; tabela mostra ~US$15/mês). O `read-cutover` de tenant agora expõe esse relatório — o número errado engana.

## Decisão

### 1. Transcrição flag-gated por provider

Env `TRANSCRIBE_PROVIDER`:
- **`local` (default / ausente)** — Whisper `:9000`. Comportamento **idêntico ao atual**, byte-a-byte. Nada muda enquanto a flag não for ligada.
- **`openai`** — roteia o áudio pra `audio.transcriptions.create` (mesma chave/SDK do chat).

Lida em **runtime** no `packages/integrations`, NÃO obrigatória no boot (lição #247: env nova nunca derruba api/worker). A assinatura `transcribe(audio, mimetype) -> texto` permanece — o `router.ts` não muda de chamada.

### 2. Modelo de transcrição recomendado: `gpt-4o-mini-transcribe`

Preços oficiais OpenAI (confirmados 2026-06-13, `https://openai.com/api/docs/pricing`):

| Modelo | Custo estimado | Qualidade PT-BR | Formatos resposta |
|---|---|---|---|
| `whisper-1` | ~US$0.006/min | boa | json/text/srt/vtt/verbose_json |
| **`gpt-4o-mini-transcribe`** (escolhido) | **~US$0.003/min** | superior ao whisper-1 | json/text |
| `gpt-4o-transcribe` | ~US$0.006/min | melhor | json/text |

`gpt-4o-mini-transcribe` é **metade do preço** do whisper-1 com qualidade igual ou superior em PT-BR. Configurável por `OPENAI_TRANSCRIBE_MODEL` sem deploy. `language: 'pt'` fixado (corta latência e erro de detecção em áudio curto).

### 3. Fail-safe

Com `openai`, se a OpenAI falhar (timeout/429/codec), faz **fallback pro Whisper local** (a menos que `TRANSCRIBE_OPENAI_FALLBACK_LOCAL=false`). Se o local também cair, o `router.ts` já trata a exceção com o marcador `[áudio não transcrito]` — **o atendimento nunca cai por causa de transcrição**.

### 4. Fix do medidor de custo (`model_usage.cost_usd`)

Três erros multiplicativos corrigidos em `packages/db/src/queries/model-usage.ts`:

1. **Caching ignorado (dominante):** uso input-dominado (agenda GCal re-injetada por turno = prefixo estável, sempre cache-hit ≥1024 tokens). O código cobrava todo input à tarifa cheia; o `cached_tokens` (subconjunto de `prompt`, exposto em `usage.prompt_tokens_details.cached_tokens`) agora é cobrado à tarifa de cache (gpt-5.4: **$0.25/1M, ~10x mais barato** que $2.50).
2. **Input errado:** gpt-5.4 estava como **$5.00** (estimativa); oficial é **$2.50** (2x).
3. **Output errado:** estava **$20.00**; oficial é **$15.00** (1.33x).

`runAgent` passa a capturar `cached`; `logUsage` recebe `cached` (opcional, default 0 = comportamento antigo). **Sem migration** — o `cost_usd` continua sendo a mesma coluna, só calculado certo daqui pra frente.

## Alternativas consideradas

| Opção | Custo | Prós | Contras | Decisão |
|---|---|---|---|---|
| **Manter Whisper local** | infra (RAM+CPU) | sem dado saindo da VPS; sem dependência externa | gargalo nº1 (teto ~15–30 clientes); serial em 2 vCPU; 1.3 GiB RAM presa | **rejeitada** como destino; **mantida** como fallback runtime |
| **OpenAI `whisper-1`** | ~US$0.006/min | API estável, formatos ricos (srt/vtt/verbose_json) | 2x mais caro que mini; qualidade só "boa" em PT-BR | rejeitada (preço/qualidade pior que mini) |
| **OpenAI `gpt-4o-mini-transcribe`** | ~US$0.003/min | mais barato; PT-BR igual/superior; mesma chave/SDK | formatos json/text só (não precisamos dos demais) | **ESCOLHIDA** |
| **OpenAI `gpt-4o-transcribe`** | ~US$0.006/min | melhor qualidade absoluta | 2x o mini sem ganho material no nosso caso (áudio curto PT-BR) | rejeitada (custo sem payoff); fica como upgrade trivial via `OPENAI_TRANSCRIBE_MODEL` se preciso |
| **Multimodal direto (áudio → resposta, sem passo de transcrição)** | variável | um hop a menos | quebra memória/tool-use textuais; menos observável (sem texto no log/memória); mais caro e mais acoplado | rejeitada por ora; **norte distante** |

O modelo é trocável por env (`OPENAI_TRANSCRIBE_MODEL`), então mini → gpt-4o-transcribe é mudança de config, não de código — reversível sem deploy.

## Capacidade — novo teto

Com `openai` ativo, o Whisper local pode ser **desligado** (enable encenado, depois do canary):
- Libera **~1.3 GiB de RAM fixa** + devolve os **2 vCPU** (hoje reféns de picos de transcrição).
- **Teto da VPS sobe de ~15–30 → ~50 clientes** (passa a ser limitado só por RAM/WAHA, não mais por CPU de áudio).
- Custo: barbearia manda poucos áudios curtos/dia → **US$1–3/cliente/mês** de transcrição (provavelmente menos).

## Plano de enable (ENCENADO — NÃO neste PR)

Ordem obrigatória. Cada passo só avança após o anterior validar. **Whisper local fica ligado o tempo todo até o passo 4.**

1. **Merge do PR flag-gated** (default `local` = nada muda byte-a-byte). Whisper local segue ligado. Sem efeito em produção.
2. **Canary num áudio OGG/opus REAL** na sessão `WHATSAPP_ROUTER_TESTE` (sessão de teste interna, NUNCA num cliente pagante): provisionar `TRANSCRIBE_PROVIDER=openai` + `OPENAI_TRANSCRIBE_MODEL` só nessa sessão, enviar voice note OGG/opus real e validar:
   - **codec aceito** — a OpenAI ingeriu o container OGG/opus sem erro (a doc lista mp3/mp4/m4a/wav/webm; OGG não é citado explicitamente — **o canary é quem confirma**);
   - **qualidade PT-BR** da transcrição;
   - **latência** ponta-a-ponta aceitável vs. Whisper local.
3. **Validado o canary → ligar `openai` nos clientes** (Cirilo/Samuel) com `TRANSCRIBE_OPENAI_FALLBACK_LOCAL` ON. Observar custo real e erros por alguns dias.
4. **SÓ DEPOIS de estável → `devops-sre` desliga o container `automacoes-whisper-1`** (libera RAM/CPU). **A decisão de desligar é exclusiva do Bruno** e só ocorre quando o passo 3 estiver verde. Enquanto o container estiver de pé, o fallback local continua disponível.

## Riscos

- **Codec OGG/opus na OpenAI:** não documentado explicitamente. Mitigação: o **canary (passo 2)** é gate — se o codec falhar, o enable não avança e o fallback local cobre. Não desligar o Whisper enquanto isso não for provado.
- **Latência adicional:** chamada de rede externa no caminho de áudio. Mitigação: `language: 'pt'` fixado; medir no canary; fallback local em timeout/429.
- **Dependência externa nova** (OpenAI) no caminho de áudio. Mitigação: fail-safe em duas camadas (OpenAI → Whisper local → marcador `[áudio não transcrito]`); o atendimento nunca cai por transcrição.
- **LGPD — áudio sai da VPS pra OpenAI:** a voz do cliente passa a trafegar para um terceiro fora da VPS. É a **mesma classe de dado que o texto do chat que JÁ vai pra OpenAI hoje** — não introduz categoria nova de exposição, mas amplia o volume. Alinhar com `juridico-lgpd` antes do enable amplo (passo 3). Sem PII estruturada (CPF etc.) adicionada além do conteúdo da própria mensagem de voz.

## Rollback

- **Reversão imediata, sem deploy:** setar `TRANSCRIBE_PROVIDER=local` (ou remover a env) volta o pipeline ao Whisper local byte-a-byte. É a configuração default — basta tirar a flag.
- O container `automacoes-whisper-1` **permanece de pé** até o passo 4 do enable, então o rollback do passo 3 é trocar uma env. Não há migration nem mudança de schema para reverter.
- O fix de `cost_usd` (item 4) é só cálculo daqui pra frente, mesma coluna — sem dado destruído; rollback é reverter o commit do cálculo se necessário.

## Consequências

- (+) Remove o teto-duro de capacidade; dobra o teto da VPS sem trocar máquina.
- (+) Custo de transcrição centralizado na conta do Bruno, observável.
- (+) `cost_usd` para de enganar (~70x → real).
- (−) Dependência externa nova no caminho de áudio (mitigada por fallback local).
- (−) Áudio sai da VPS pra OpenAI — sem PII além da voz do cliente; alinhar com `juridico-lgpd` antes do enable amplo (mesma classe de dado que já vai pro chat OpenAI hoje).

## Critérios de aceitação (verificáveis)

- Com a flag ausente/`local`, a saída de `transcribe()` é idêntica à atual (canary negativo: bot responde como hoje).
- Canary no `WHATSAPP_ROUTER_TESTE` com OGG/opus real retorna transcrição PT-BR coerente via OpenAI, com latência medida e registrada.
- Falha forçada da OpenAI (chave inválida no teste) cai pro Whisper local sem derrubar o atendimento.
- Container `automacoes-whisper-1` só é desligado após Cirilo/Samuel estáveis em `openai` e com aprovação explícita do Bruno.

## Status

**Proposta — aguardando aprovação do Bruno.** Não mergear, não mexer em produção, não desligar o Whisper antes do enable encenado.
