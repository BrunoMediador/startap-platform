# CUTOVER n8n → TS Platform

Data: 2026-05-14

## Estado da migração

Todos os bots do n8n foram migrados para TypeScript e rodam em containers Docker no servidor `187.77.242.220` na pasta `/opt/automacoes/code/`.

| Container | Função | Porta |
|---|---|---|
| `startap-api` | Webhook receiver + 4 bots (Echo, Cirilo, Ricardo, Startap) | 3040 (interna) |
| `startap-worker` | Cron jobs (antibot a cada 1min, cleanup-chat a cada 12h) | - |
| `startap-redis` | Cache | 6379 (interna) |

Build limpo: `docker run --rm -v /opt/automacoes/code:/app -w /app node:20-alpine sh -c 'npm run build --workspaces --if-present'`

## Passos pendentes para deixar em produção

### 1. ⚠️ Habilitar Google Calendar API no projeto

A API está **desabilitada** no projeto `barbearia-495823`. Sem isso, o bot do Cirilo não consegue criar nem consultar agendamentos.

1. Abra: https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=645798356726
2. Clique em **ENABLE**
3. Aguarde ~5 minutos pra propagar

### 2. Configurar Nginx Proxy Manager

Subdomínio sugerido: `api-startap.startap.tech` (ou outro que preferir).

No NPM web UI:

1. **Hosts → Proxy Hosts → Add Proxy Host**
2. **Details tab:**
   - Domain Names: `api-startap.startap.tech`
   - Scheme: `http`
   - Forward Hostname: `startap-api`
   - Forward Port: `3040`
   - ☑ Block Common Exploits
   - ☑ Websockets Support
3. **SSL tab:**
   - SSL Certificate: `Request a new SSL Certificate`
   - ☑ Force SSL
   - ☑ HTTP/2 Support
   - Email: seu email
   - ☑ I Agree to Let's Encrypt Terms
4. Save

Após salvar, valide acessando: `https://api-startap.startap.tech/health` (deve retornar JSON `{"status":"ok"}`).

### 3. Trocar webhook do WAHA

A sessão `TESTE_STARTAP` está apontando para o n8n. Para trocar para o TS platform, rode no servidor:

```bash
ssh root@187.77.242.220 "docker exec automacoes-waha-1 curl -s -X PUT 'http://localhost:3000/api/sessions/TESTE_STARTAP' \\
  -H 'X-Api-Key: 0adad70452c443c1834ee6408588f950' \\
  -H 'Content-Type: application/json' \\
  -d '{
    \"config\": {
      \"webhooks\": [
        {
          \"url\": \"https://api-startap.startap.tech/webhooks/waha\",
          \"events\": [\"message\", \"message.any\"]
        }
      ]
    }
  }'"
```

> Se quiser fazer rollback, basta voltar o URL para `https://n8n.startap.tech/webhook/router-teste-startap`.

### 4. Validar produção

Mande uma mensagem real pelo WhatsApp para a conta da sessão `TESTE_STARTAP` e:

```bash
# Acompanhe os logs em tempo real
ssh root@187.77.242.220 "docker logs startap-api -f"
```

Você deve ver linhas tipo:
```
{"level":"info","module":"router","telefone":"5535...","msg":"Mensagem processada"}
```

Se aparecer `ignored:no-routing`, é número não cadastrado — precisa adicionar manualmente em `routing_clientes`.

### 5. Apagar workflows do n8n (manter o serviço rodando)

Após validar que o TS platform está atendendo direito (mande 2-3 mensagens de teste e veja respostas):

```bash
# Apagar workflows do n8n via API
API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."  # mesma do reference_n8n_credentials.md

for ID in \
  dlpKXM3gvX2joC1b \
  uUS3Ux1cU2DquKxo \
  DLN3l6xO7uZlTE63 \
  TZFnKzCeQPIvs1Lj \
  W2J7ryqasM04kwqQ \
  0ni38aSspWwhooHd \
  DdHrYrnSfJjcSXUz \
  yXxDA41urvllq3mI \
  FUyZ9xxr2QHdi4Ei \
  1sGNJEPE1JcWMfqE \
  V9c4IB2gwvNHQKNN
do
  curl -s -X DELETE "https://n8n.startap.tech/api/v1/workflows/$ID" \
    -H "X-N8N-API-KEY: $API_KEY"
  echo "Deleted $ID"
done
```

O container `automacoes-n8n-1` continua rodando — você pode acessar https://n8n.startap.tech e criar novos workflows quando quiser. Apenas os 11 workflows produção foram deletados.

## Adicionar novos clientes em produção

Para um novo cliente receber atendimento do bot:

```bash
# Cliente da Barbearia Cirilo
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c \"
INSERT INTO routing_clientes (telefone, workflow_target, nome_cliente, workflow_id, workflow_name, webhook_url, ativo)
VALUES ('5535999XXXXXX', 'cirilo', 'Nome Cliente', '0ni38aSspWwhooHd', 'TESTE_BARBEARIAS_AGENDAMENTOS', 'https://api-startap.startap.tech/webhooks/waha', true)
ON CONFLICT (telefone) DO NOTHING;\""

# Cliente do Curso Ricardo
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c \"
INSERT INTO routing_clientes (telefone, workflow_target, nome_cliente, workflow_id, workflow_name, webhook_url, ativo)
VALUES ('5519XXXXXXXXX', 'ricardo', 'Nome Cliente', 'dlpKXM3gvX2joC1b', 'elenildo.ricardo', 'https://api-startap.startap.tech/webhooks/waha', true)
ON CONFLICT (telefone) DO NOTHING;\""
```

## Comandos úteis de manutenção

```bash
# Logs em tempo real
ssh root@187.77.242.220 "docker logs startap-api -f"
ssh root@187.77.242.220 "docker logs startap-worker -f"

# Rebuild após mudança no código
ssh root@187.77.242.220 "cd /opt/automacoes/code && git pull && docker compose build && docker compose up -d"

# Health check
curl https://api-startap.startap.tech/health

# Listar quem está roteado
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c 'SELECT telefone, nome_cliente, workflow_name, ativo FROM routing_clientes ORDER BY telefone;'"

# Listar quem está em pausa manual (Cirilo)
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c 'SELECT * FROM pausa_cirilo;'"

# Build local (node não está no host)
ssh root@187.77.242.220 "docker run --rm -v /opt/automacoes/code:/app -w /app node:20-alpine sh -c 'npm run build --workspaces --if-present'"
```
