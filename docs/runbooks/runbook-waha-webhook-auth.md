# Runbook: Ativar auth do webhook WAHA (`WAHA_WEBHOOK_SECRET`)

**Origem**: card P0 da security (review do PR #268). Pré-requisito pra ligar `PORTAL_SIGNUP`.
**O que muda**: `POST /webhooks/waha` (startap-api) passa a exigir o header `X-Webhook-Secret`
com o secret compartilhado. Sem a env, NADA muda (retrocompatível — lição do incidente #247).
**Quem executa**: devops-sre ou Bruno. **Janela**: 01–05h BRT (precaução; a Fase A é zero-risco,
mas a Fase B mexe no container da api). **Cirilo por último, SEMPRE.**

---

## Regras antes de começar

1. **Log incremental OBRIGATÓRIO** (lição da casa: executor longo esquece a própria execução).
   Antes do passo 1, crie/abra o log e **anote CADA passo concluído imediatamente**:
   ```bash
   mkdir -p /opt/automacoes/runbook-logs
   echo "$(date -Iseconds) — INICIO runbook waha-webhook-auth — executor: <quem>" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
   ```
2. **Ordem das fases importa.** Sessões PRIMEIRO (Fase A — header extra é ignorado pela api
   enquanto a env não existe), env DEPOIS (Fase B). Inverter = todas as sessões levam 401 = bots mudos.
3. **NUNCA** `docker pull devlikeapro/waha-plus` (imagem congelada), **NUNCA** logout/stop de sessão.
   Este runbook não reinicia NENHUMA sessão WAHA.
4. O serviço compose da api chama **`api`** (container `startap-api`) em `/opt/automacoes/code/docker-compose.yml`, env em `/opt/automacoes/code/.env`.

## Confirmações pendentes do waha-specialist (NÃO executar a Fase A sem isso)

- [ ] A nossa imagem WAHA Plus congelada (engine NOWEB) suporta `webhooks[].customHeaders`
      na config da sessão (campo persiste no GET e o header é de fato ENVIADO no POST).
- [ ] `PUT /api/sessions/{name}` com config atualizada aplica **sem derrubar/reiniciar** uma
      sessão WORKING (precedente nosso: o endpoint `ensure-audio-webhook` do painel-admin faz
      esse mesmo PUT read-modify-write em sessão viva desde 2026-05-21 — mas confirmar).
- [ ] Se `customHeaders` NÃO for suportado: **ABORTAR** e voltar pro PM (alternativa seria o
      HMAC nativo do WAHA — outro design, outro PR).

---

## Passo 0 — Já foi aplicado? (idempotência)

```bash
# 0.1 Env já existe na api?
grep -c '^WAHA_WEBHOOK_SECRET=' /opt/automacoes/code/.env   # 1 = Fase B já feita

# 0.2 Boot warn presente? (se aparecer, a env NÃO está ativa na api)
docker logs startap-api 2>&1 | grep -c 'Webhook WAHA sem auth' # >0 = enforcement DESLIGADO

# 0.3 Sessões já têm o customHeader? (repetir por sessão)
# Descobrir acesso ao WAHA: WAHA_URL/WAHA_API_KEY estão em /opt/automacoes/code/.env
# (alternativa: docker port automacoes-waha-1 pra achar a porta publicada).
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/STARTAP_AI_PROD" \
  | grep -o 'customHeaders[^]]*]'   # vazio = Fase A pendente pra essa sessão
```

Registre no log o resultado do passo 0. Se 0.1=1 **e** 0.3 mostra o header em todas as sessões,
o runbook JÁ FOI aplicado — pare aqui.

## Passo 1 — Gerar o secret

```bash
SECRET=$(openssl rand -hex 32)
echo "secret gerado (NÃO anotar o valor no log do runbook)"
echo "$(date -Iseconds) — passo 1 OK (secret gerado)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

Guarde o valor APENAS no `.env` (passo 3) e na config das sessões (passo 2). Nunca em log/commit/chat.

## Passo 2 — Fase A: adicionar o header em CADA sessão WAHA (zero risco)

Enquanto a env não existe na api, o header extra é **ignorado** — esta fase não muda comportamento.
**Ordem**: 1) `WHATSAPP_ROUTER_TESTE` (teste interno) → 2) `barbeariacarlosolvv` (ambiente de
teste) → 3) `STARTAP_AI_PROD` (Lola) → 4) **`cirilobarbearia` (Cirilo, pagante) POR ÚLTIMO**,
e só depois de validar o padrão nas anteriores. Sessões `clone_*` extras: listar com
`curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions?all=true"`.

Para CADA sessão (read-modify-write — NUNCA sobrescrever a config sem ler antes; preserve
`url` e `events` exatamente como estão):

```bash
NAME=WHATSAPP_ROUTER_TESTE
# 2.1 Ler config atual e SALVAR cópia (rollback da config)
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/$NAME" \
  > /opt/automacoes/runbook-logs/waha-session-$NAME-antes.json

# 2.2 Montar a MESMA config adicionando customHeaders em cada webhook:
#   "webhooks": [{ ...igual estava..., "customHeaders": [{"name":"X-Webhook-Secret","value":"<SECRET>"}] }]
# e aplicar via PUT (waha-specialist confirma se o PUT preserva a sessão WORKING):
curl -s -X PUT -H "X-Api-Key: $WAHA_API_KEY" -H 'Content-Type: application/json' \
  -d '{"config":{...config atual com customHeaders...}}' "$WAHA_URL/api/sessions/$NAME"

# 2.3 Validar: campo persistiu? status continua o MESMO de antes (WORKING segue WORKING)?
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/$NAME" | grep -o '"status":"[A-Z_]*"'
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/$NAME" | grep -c 'X-Webhook-Secret'
echo "$(date -Iseconds) — passo 2 OK sessão $NAME" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

**Se o GET pós-PUT não mostrar `customHeaders`**: a imagem não suporta o campo — **ABORTAR**
(nada foi quebrado; a config aplicada é igual à anterior) e reportar ao PM.

## Passo 3 — Fase B: ligar o enforcement na api

```bash
# 3.1 Adicionar a env (NÃO ecoar o valor em lugar nenhum)
echo "WAHA_WEBHOOK_SECRET=<SECRET>" >> /opt/automacoes/code/.env
chmod 600 /opt/automacoes/code/.env   # já deveria estar; garantir

# 3.2 Recriar SÓ a api (worker não usa a rota; sessões WAHA NÃO são tocadas)
cd /opt/automacoes/code && docker compose up -d api

# 3.3 Boot limpo? O warn "Webhook WAHA sem auth" NÃO pode mais aparecer
docker logs --tail 50 startap-api 2>&1 | grep -E 'API rodando|Webhook WAHA sem auth'
echo "$(date -Iseconds) — passo 3 OK (env ativa, api recriada)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

## Passo 4 — Validar (não pular)

```bash
# 4.1 Sem header -> 401 (de dentro da rede docker; ajuste o curl ao seu acesso)
docker exec automacoes-painel-admin-1 \
  node -e "fetch('http://startap-api:3040/webhooks/waha',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))"
# esperado: 401

# 4.2 Com header certo -> 200 (payload vazio responde 200 ignored:invalid-payload — ok)
docker exec automacoes-painel-admin-1 \
  node -e "fetch('http://startap-api:3040/webhooks/waha',{method:'POST',headers:{'content-type':'application/json','X-Webhook-Secret':process.argv[1]},body:'{}'}).then(r=>console.log(r.status))" '<SECRET>'
# esperado: 200

# 4.3 Prova real: mandar mensagem de WhatsApp pra Lola (STARTAP_AI_PROD) e ver processar
docker logs --tail 100 -f startap-api 2>&1 | grep -E 'Webhook WAHA rejeitado|webhook.received|router'
# esperado: processamento normal, ZERO "Webhook WAHA rejeitado" vindo do IP do WAHA
echo "$(date -Iseconds) — passo 4 OK (validação 401/200 + mensagem real)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

**Se aparecer `Webhook WAHA rejeitado` em rajada após o passo 3** = alguma sessão NÃO está
enviando o header → rollback IMEDIATO (passo 6) e investigar a Fase A dessa sessão.

## Passo 5 — Painel-admin (sessões NOVAS nascem com o header)

O wizard de clone/sessão do painel-admin (`gestao.startap.tech`) só injeta o `customHeaders`
se a MESMA env existir no container dele (compose legado em `/opt/automacoes/`):

```bash
echo "WAHA_WEBHOOK_SECRET=<SECRET>" >> /opt/automacoes/.env   # confirmar qual env_file o serviço usa
cd /opt/automacoes && docker compose up -d painel-admin        # confirmar nome do serviço no compose legado
echo "$(date -Iseconds) — passo 5 OK (painel-admin com env)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

Sem este passo, sessão criada pelo painel após a Fase B levaria 401 (bot novo nasceria surdo).

## Passo 6 — Rollback (a qualquer momento, <2 min, sem tocar nas sessões)

```bash
# Remover a env e recriar a api — volta EXATAMENTE ao comportamento anterior (aceita tudo).
sed -i '/^WAHA_WEBHOOK_SECRET=/d' /opt/automacoes/code/.env
cd /opt/automacoes/code && docker compose up -d api
docker logs --tail 20 startap-api 2>&1 | grep 'Webhook WAHA sem auth'   # warn de volta = rollback OK
echo "$(date -Iseconds) — ROLLBACK executado" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

Os `customHeaders` podem FICAR nas sessões (são inofensivos sem a env). Se quiser remover,
restaurar a config salva em `/opt/automacoes/runbook-logs/waha-session-<NAME>-antes.json`.

## Encerramento

```bash
echo "$(date -Iseconds) — FIM runbook waha-webhook-auth — status: <ok|rollback|abortado>" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

Reportar ao PM: status final, sessões atualizadas, e se houve qualquer 401 inesperado.
