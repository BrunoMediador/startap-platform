# ADR 0021: Transcrição de áudio via OpenAI (offload do Whisper local) + fix do medidor de custo

> **Quem escreve:** `ai-engineer` (desenho) — formaliza com `arquiteto`
> **Onde fica:** `docs/adr/0021-transcricao-via-openai.md`
> **Quando usar:** Mudança de pipeline de transcrição de áudio do WhatsApp. Remover o teto-duro de capacidade da VPS (Whisper local) e centralizar custo de transcrição na conta OpenAI do Bruno.

---

**Status:** proposta — aguardando aprovação de Bruno
**Data:** 2026-06-13
**Autor:** ai-engineer
**Aprovado por:** pendente
**Relacionados:** `docs/capacidade-vps-100-clientes.md` (Whisper local = gargalo nº1), ADR 0018 (tenant_id), ADR 0020 (shard WAHA). Lição do incidente #247 (env nova nunca derruba o boot).

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

**Trade-off registrado (multimodal direto):** poderíamos mandar o áudio direto pra um modelo multimodal (áudio → resposta sem passo de transcrição). Descartado por ora: o caminho `transcrever → chat` é mais simples (mantém memória/tool-use textuais intactos), mais barato e mais observável (texto transcrito vai pro log/memória). Fica como norte distante.

**Nuance OGG/opus:** a doc OpenAI lista mp3/mp4/m4a/wav/webm; OGG não é citado explicitamente, mas o container Ogg é aceito na prática. O cliente envia o mimetype real + extensão coerente. O **canary valida** isso com áudio real antes do enable amplo; se algum codec falhar, o fallback local cobre.

### 3. Fail-safe

Com `openai`, se a OpenAI falhar (timeout/429/codec), faz **fallback pro Whisper local** (a menos que `TRANSCRIBE_OPENAI_FALLBACK_LOCAL=false`). Se o local também cair, o `router.ts` já trata a exceção com o marcador `[áudio não transcrito]` — **o atendimento nunca cai por causa de transcrição**.

### 4. Fix do medidor de custo (`model_usage.cost_usd`)

Três erros multiplicativos corrigidos em `packages/db/src/queries/model-usage.ts`:

1. **Caching ignorado (dominante):** uso input-dominado (agenda GCal re-injetada por turno = prefixo estável, sempre cache-hit ≥1024 tokens). O código cobrava todo input à tarifa cheia; o `cached_tokens` (subconjunto de `prompt`, exposto em `usage.prompt_tokens_details.cached_tokens`) agora é cobrado à tarifa de cache (gpt-5.4: **$0.25/1M, ~10x mais barato** que $2.50).
2. **Input errado:** gpt-5.4 estava como **$5.00** (estimativa); oficial é **$2.50** (2x).
3. **Output errado:** estava **$20.00**; oficial é **$15.00** (1.33x).

`runAgent` passa a capturar `cached`; `logUsage` recebe `cached` (opcional, default 0 = comportamento antigo). **Sem migration** — o `cost_usd` continua sendo a mesma coluna, só calculado certo daqui pra frente.

## Capacidade — novo teto

Com `openai` ativo, o Whisper local pode ser **desligado** (enable encenado, depois do canary):
- Libera **~1.3 GiB de RAM fixa** + devolve os **2 vCPU** (hoje reféns de picos de transcrição).
- **Teto da VPS sobe de ~15–30 → ~50 clientes** (passa a ser limitado só por RAM/WAHA, não mais por CPU de áudio).
- Custo: barbearia manda poucos áudios curtos/dia → **US$1–3/cliente/mês** de transcrição (provavelmente menos).

## Plano de enable (encenado — NÃO neste PR)

1. Merge do PR flag-gated (default `local` = nada muda). **Whisper local segue ligado.**
2. Provisionar `TRANSCRIBE_PROVIDER=openai` + `OPENAI_TRANSCRIBE_MODEL` numa sessão de teste (`WHATSAPP_ROUTER_TESTE`). Canary com áudio OGG real (qualidade PT-BR + codec).
3. Validado o canary → ligar `openai` nos clientes (Cirilo/Samuel) com fallback local ON.
4. Só depois de estável → `devops-sre` desliga o container `automacoes-whisper-1` (libera RAM/CPU). **Decisão de desligar = Bruno.**

## Consequências

- (+) Remove o teto-duro de capacidade; dobra o teto da VPS sem trocar máquina.
- (+) Custo de transcrição centralizado na conta do Bruno, observável.
- (+) `cost_usd` para de enganar (~70x → real).
- (−) Dependência externa nova no caminho de áudio (mitigada por fallback local).
- (−) Áudio sai da VPS pra OpenAI — sem PII além da voz do cliente; alinhar com `juridico-lgpd` antes do enable amplo (mesma classe de dado que já vai pro chat OpenAI hoje).
