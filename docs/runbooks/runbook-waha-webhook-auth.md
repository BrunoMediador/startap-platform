# Runbook: Ativar auth do webhook WAHA (HMAC plano A / header estático plano B)

**Origem**: card P0 da security (review do PR #268) + spike `docs/missoes/spike-waha-meid-customheaders.md`
(2026-06-11, waha-specialist). Pré-requisito pra ligar `PORTAL_SIGNUP`.
**O que muda**: `POST /webhooks/waha` (startap-api) passa a exigir auth. Precedência no api:

| Env presente | Modo | Como autentica |
|---|---|---|
| `WAHA_WEBHOOK_HMAC_KEY` | **Plano A — HMAC nativo (recomendado)** | WAHA assina o raw body de cada POST (`webhooks[].hmac.key` na sessão); api valida timing-safe ANTES do JSON.parse. Headers esperados: `X-Webhook-Hmac` (hex) + algoritmo sha512 — confirmar na cobaia (passo 3) |
| só `WAHA_WEBHOOK_SECRET` | Plano B — header estático | header `X-Webhook-Secret` via `webhooks[].customHeaders` |
| nenhuma | aberto (atual) | aceita tudo + warn no boot (retrocompat — lição do incidente #247) |

**Quem executa**: devops-sre ou Bruno. **NUNCA execute a partir do PR — código/teste/doc apenas.**
**Janela**: cobaia `WHATSAPP_ROUTER_TESTE` em qualquer horário (avisar Bruno). Sessões de
**cliente** (`cirilobarbearia`, `STARTAP_AI_PROD`) **SÓ na janela 01–05h BRT**. **Cirilo por
último, SEMPRE.**

---

## O que o spike confirmou (2026-06-11) — ler antes de executar

1. A imagem congelada (2026.3.2, NOWEB, Plus) **suporta `webhooks[].hmac.key` E
   `webhooks[].customHeaders`** (schema `WebhookConfig` do OpenAPI da própria instância).
2. ⚠️ **`PUT /api/sessions/{name}` é REPLACE de config, NÃO merge.** Mandar config parcial
   **APAGA `events` e `retries`** → bot surdo pra áudio e pause do dono quebrado (repete o bug
   do `message.any`). **Ciclo obrigatório: GET → editar localmente → PUT com a config COMPLETA.**
3. ⚠️ **O PUT reinicia a sessão** (stop+start automático, SEM logout — credenciais NOWEB
   persistem no store Postgres, **não pede QR**). Downtime esperado: segundos de reconexão.
   Por isso: cobaia primeiro, clientes só na janela. Raro: pode cair em FAILED e exigir
   `POST /api/sessions/{name}/restart` manual.
4. Os nomes `X-Webhook-Hmac` / `X-Webhook-Hmac-Algorithm: sha512` vêm da doc nova do WAHA — o
   OpenAPI da versão congelada não os crava. O passo 3 confirma na cobaia. Se divergirem, as
   envs `WAHA_WEBHOOK_HMAC_HEADER` / `WAHA_WEBHOOK_HMAC_ALGORITHM` ajustam o api **sem novo
   deploy de código**.

## Regras antes de começar

1. **Log incremental OBRIGATÓRIO** (lição da casa: executor longo esquece a própria execução).
   Antes do passo 0, crie/abra o log e **anote CADA passo concluído imediatamente**:
   ```bash
   mkdir -p /opt/automacoes/runbook-logs
   echo "$(date -Iseconds) — INICIO runbook waha-webhook-auth (HMAC) — executor: <quem>" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
   ```
2. **Ordem das fases importa.** Sessões PRIMEIRO (Fase A — o WAHA passa a ASSINAR, mas o api
   ignora a assinatura enquanto a env não existe: é o "modo log-only" de fato), env DEPOIS
   (Fase B). Inverter = todas as sessões levam 401 = bots mudos.
3. **NUNCA** `docker pull devlikeapro/waha-plus` (imagem congelada), **NUNCA** logout de sessão.
   Este runbook **REINICIA** as sessões que receberem PUT (item 3 acima) — planejar a janela.
4. O serviço compose da api chama **`api`** (container `startap-api`) em
   `/opt/automacoes/code/docker-compose.yml`, env em `/opt/automacoes/code/.env`.
5. A key é **global por ambiente** (decisão da escala atual — 4 sessões; tech debt registrado:
   key por sessão isolaria "sessão A forjando evento da sessão B").

---

## Passo 0 — Já foi aplicado? (idempotência)

```bash
# 0.1 Env já existe na api?
grep -c '^WAHA_WEBHOOK_HMAC_KEY=' /opt/automacoes/code/.env   # 1 = Fase B já feita
grep -c '^WAHA_WEBHOOK_SECRET='   /opt/automacoes/code/.env   # plano B legado?

# 0.2 Boot warn presente? (se aparecer, enforcement DESLIGADO)
docker logs startap-api 2>&1 | grep -c 'Webhook WAHA sem auth'
# (se ativo, o boot loga 'Auth do webhook WAHA ativa' com o modo)

# 0.3 Sessões já têm hmac.key? (repetir por sessão; WAHA_URL/WAHA_API_KEY em /opt/automacoes/code/.env)
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/WHATSAPP_ROUTER_TESTE" \
  | grep -o '"hmac":{[^}]*}'   # vazio ou "key":null = Fase A pendente pra essa sessão
```

Registre o resultado no log. Se 0.1=1 **e** 0.3 mostra `hmac.key` em todas as sessões, o
runbook JÁ FOI aplicado — pare aqui.

## Passo 1 — Gerar a key

```bash
SECRET=$(openssl rand -hex 32)
echo "key gerada (NÃO anotar o valor no log do runbook)"
echo "$(date -Iseconds) — passo 1 OK (key gerada)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

Guarde o valor APENAS no `.env` (Fase B) e na config das sessões (Fase A). Nunca em
log/commit/chat. Obs.: o dashboard do WAHA exibe a config da sessão em claro — a key fica
visível pra quem tem as credenciais `WAHA_DASHBOARD_*` (aceito; mesmo perímetro do `.env`).

## Passo 2 — Fase A na COBAIA: `WHATSAPP_ROUTER_TESTE` (sessão interna, zero cliente)

Ciclo **GET → editar → PUT** com a config **COMPLETA** (REPLACE! — ver item 2 do spike):

```bash
NAME=WHATSAPP_ROUTER_TESTE
# 2.1 Ler a config atual e SALVAR cópia (rollback da config)
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/$NAME" \
  > /opt/automacoes/runbook-logs/waha-session-$NAME-antes.json

# 2.2 Montar o body do PUT a partir da config SALVA, adicionando hmac em CADA webhook
#     e preservando url/events/retries/customHeaders EXATAMENTE como estavam:
jq --arg key "$SECRET" '{config: (.config | .webhooks = (.webhooks | map(. + {hmac: {key: $key}})))}' \
  /opt/automacoes/runbook-logs/waha-session-$NAME-antes.json > /tmp/put-$NAME.json
jq '.config.webhooks[] | {url, events, hmac: (.hmac.key != null)}' /tmp/put-$NAME.json
# CONFERIR NO OLHO: events tem de continuar IGUAL ao -antes.json (message.any incluso onde havia).
# Se events sumiu/mudou -> NÃO faça o PUT. Investigar o jq.

# 2.3 Aplicar (vai reiniciar a sessão — stop+start, sem logout)
curl -s -X PUT -H "X-Api-Key: $WAHA_API_KEY" -H 'Content-Type: application/json' \
  -d @/tmp/put-$NAME.json "$WAHA_URL/api/sessions/$NAME" && rm /tmp/put-$NAME.json

# 2.4 Validar: volta a WORKING em <60s? hmac persistiu? events intactos?
sleep 30
curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/$NAME" \
  | jq '{status, webhooks: [.config.webhooks[] | {events, hmac: (.hmac.key != null)}]}'
echo "$(date -Iseconds) — passo 2 OK sessão $NAME" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

- **Se o GET pós-PUT não mostrar `hmac.key`**: a imagem não aplicou o campo → restaurar a
  config de `-antes.json` (mesmo ciclo) e cair pro **Plano B** (passo 8).
- **Se a sessão ficar FAILED >60s**: `curl -s -X POST -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/$NAME/restart"`.

## Passo 3 — Confirmar nome/algoritmo do header HMAC na cobaia (ANTES da Fase B)

O tráfego WAHA→api é HTTP interno (porta 3040) — dá pra inspecionar os headers no host:

```bash
# No VPS, terminal 1 (captura 60s):
timeout 60 tcpdump -A -s0 -i any port 3040 2>/dev/null | grep -i -E 'hmac|webhook'
# Terminal 2 (ou celular): mandar UMA mensagem de WhatsApp pro número da ROUTER_TESTE.
```

- Esperado: `X-Webhook-Hmac: <hex>` (e, se vier, `X-Webhook-Hmac-Algorithm: sha512`).
- **Se vier OUTRO nome/algoritmo**: anotar no log; na Fase B exporte também
  `WAHA_WEBHOOK_HMAC_HEADER=<nome-em-lowercase>` e/ou `WAHA_WEBHOOK_HMAC_ALGORITHM=sha256`.
- **Se NÃO vier assinatura nenhuma**: HMAC não funciona nessa build → restaurar config da
  cobaia e cair pro **Plano B** (passo 8). Nada quebrou (api segue em modo aberto).
- Validação opcional do digest (captura o body cru e compara):
  `node -e "const c=require('crypto');console.log(c.createHmac('sha512',process.argv[1]).update(process.argv[2]).digest('hex'))" "$SECRET" '<body-cru-capturado>'`

```bash
echo "$(date -Iseconds) — passo 3 OK (header confirmado: <nome/algoritmo>)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

## Passo 4 — Fase A nas demais sessões (clientes SÓ na janela 01–05h BRT)

Mesmo ciclo do passo 2 (GET → editar → PUT completo → validar), **ordem**:

1. `barbeariacarlosolvv` (ambiente de teste do Bruno; está FAILED — aproveitar o mesmo evento
   da reconexão pendente pra aplicar a config nova);
2. `STARTAP_AI_PROD` (Lola — prospecção própria, janela mesmo assim);
3. **`cirilobarbearia` (Cirilo, PAGANTE) POR ÚLTIMO**, só depois de validar o padrão nas
   anteriores. Restart de segundos, mas é cliente — Bruno ciente, janela obrigatória.

Sessões `clone_*` extras: listar com
`curl -s -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions?all=true" | jq -r '.[].name'`.

⚠️ Em TODAS: conferir `events` no GET pós-PUT — `message.any` tem de continuar onde já existia
(Carlos hoje NÃO tem `message.any` — bug conhecido; **não** "aproveitar pra corrigir" sem o
Bruno mandar: registrar e seguir).

```bash
echo "$(date -Iseconds) — passo 4 OK (sessões: <lista>)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

## Passo 5 — Fase B: ligar o enforcement na api

```bash
# 5.1 Adicionar a env (NÃO ecoar o valor; + HEADER/ALGORITHM só se o passo 3 divergiu)
echo "WAHA_WEBHOOK_HMAC_KEY=<SECRET>" >> /opt/automacoes/code/.env
chmod 600 /opt/automacoes/code/.env

# 5.2 Recriar SÓ a api (worker não usa a rota; sessões WAHA NÃO são tocadas)
cd /opt/automacoes/code && docker compose up -d api

# 5.3 Boot limpo? Tem de logar 'Auth do webhook WAHA ativa' (webhookAuthMode=hmac)
#     e o warn 'Webhook WAHA sem auth' NÃO pode mais aparecer.
docker logs --tail 50 startap-api 2>&1 | grep -E 'Auth do webhook WAHA ativa|Webhook WAHA sem auth'
echo "$(date -Iseconds) — passo 5 OK (env ativa, api recriada)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

## Passo 6 — Validar (não pular)

```bash
# 6.1 POST sem assinatura -> 401
docker exec automacoes-painel-admin-1 \
  node -e "fetch('http://startap-api:3040/webhooks/waha',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))"
# esperado: 401

# 6.2 POST com assinatura válida -> 200 (body {} assinado; responde ignored:invalid-payload — ok)
docker exec automacoes-painel-admin-1 node -e "
const c=require('crypto');const b='{}';
const sig=c.createHmac('sha512',process.argv[1]).update(b).digest('hex');
fetch('http://startap-api:3040/webhooks/waha',{method:'POST',headers:{'content-type':'application/json','X-Webhook-Hmac':sig},body:b}).then(r=>console.log(r.status))" '<SECRET>'
# esperado: 200

# 6.3 Prova real: mensagem de WhatsApp pra ROUTER_TESTE (e depois Lola) e ver processar
docker logs --tail 100 -f startap-api 2>&1 | grep -E 'Webhook WAHA rejeitado|webhook'
# esperado: processamento normal, ZERO 'Webhook WAHA rejeitado' vindo do WAHA
echo "$(date -Iseconds) — passo 6 OK (401/200 + mensagem real)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

**Se aparecer `Webhook WAHA rejeitado` em rajada após o passo 5** = alguma sessão NÃO está
assinando (Fase A incompleta nela, ou nome de header errado) → **rollback IMEDIATO (passo 9)**
e investigar. O WAHA retenta (retries attempts 15 / 3s) — eventos do intervalo curto de
rollback não se perdem.

## Passo 7 — Sessões NOVAS nascem autenticadas (painel-admin + portal-api)

Sessão criada DEPOIS da Fase B sem `hmac.key` levaria 401 = bot novo surdo. A MESMA env precisa
existir nos dois provisionadores:

```bash
# painel-admin (gestão — compose legado em /opt/automacoes/; confirmar env_file do serviço)
echo "WAHA_WEBHOOK_HMAC_KEY=<SECRET>" >> /opt/automacoes/.env
cd /opt/automacoes && docker compose up -d painel-admin   # confirmar nome do serviço

# portal-api (signup/trial — Missão 020 F1; mesmo .env da stack nova)
grep -c '^WAHA_WEBHOOK_HMAC_KEY=' /opt/automacoes/code/.env   # já feito no passo 5.1 se o
# portal-api lê o mesmo .env; senão, adicionar no env do serviço portal-api e recriar.
echo "$(date -Iseconds) — passo 7 OK (provisionadores com env)" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

Isso é **pré-requisito pra ligar `PORTAL_SIGNUP`** (lição #247: env provisionada em prod ANTES
da feature que a exige).

## Passo 8 — Plano B (SÓ se o HMAC falhar nos passos 2–3)

Mesmas fases (sessões primeiro, env depois), trocando o campo:

- Fase A: `customHeaders: [{"name":"X-Webhook-Secret","value":"<SECRET>"}]` em cada webhook
  (mesmo ciclo GET → editar → PUT completo; mesmos avisos de REPLACE/restart/events).
- Fase B: `WAHA_WEBHOOK_SECRET=<SECRET>` no `.env` da api (NÃO definir `WAHA_WEBHOOK_HMAC_KEY`).
- Validação 6.2 com header `X-Webhook-Secret: <SECRET>` em vez da assinatura.
- Contras (por isso é plano B): secret viaja em claro em cada request interna e não dá
  integridade do body.

## Passo 9 — Rollback (a qualquer momento, <2 min, SEM tocar nas sessões)

```bash
# Remover a(s) env(s) e recriar a api — volta EXATAMENTE ao comportamento anterior (aceita tudo).
sed -i '/^WAHA_WEBHOOK_HMAC_KEY=/d;/^WAHA_WEBHOOK_HMAC_HEADER=/d;/^WAHA_WEBHOOK_HMAC_ALGORITHM=/d;/^WAHA_WEBHOOK_SECRET=/d' /opt/automacoes/code/.env
cd /opt/automacoes/code && docker compose up -d api
docker logs --tail 20 startap-api 2>&1 | grep 'Webhook WAHA sem auth'   # warn de volta = rollback OK
echo "$(date -Iseconds) — ROLLBACK executado" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

`hmac.key`/`customHeaders` podem FICAR nas sessões (assinatura/header passam a ser ignorados
pelo api sem a env — inofensivos; **não** fazer PUT só pra removê-los: PUT = restart). Se
precisar mesmo, restaurar a config salva em
`/opt/automacoes/runbook-logs/waha-session-<NAME>-antes.json`.

## Encerramento

```bash
echo "$(date -Iseconds) — FIM runbook waha-webhook-auth — status: <ok|rollback|abortado> — modo: <hmac|static|aberto>" >> /opt/automacoes/runbook-logs/waha-webhook-auth.log
```

Reportar ao PM: status final, modo ativo, sessões atualizadas (com status pós-PUT de cada),
divergência de header encontrada (se houve) e qualquer 401 inesperado.

## Tech debt registrado

- Key **global por ambiente** (não por sessão): sessão comprometida poderia forjar evento de
  outra sessão. Aceito na escala atual (4 sessões); revisitar quando houver dezenas de tenants.
- Replay: HMAC não tem timestamp/nonce nativo no WAHA — mitigado pelo dedupe de `event.id`
  (ULID) já existente no pipeline.
