# CUTOVER n8n → TS Platform

**Status: ✅ CONCLUÍDO em 2026-05-14**

## O que foi feito

| Item | Status | Quando |
|---|---|---|
| Google Calendar API habilitada (projeto barbearia-495823) | ✅ | 2026-05-14 |
| Proxy host criado no NPM (api-startap.startap.tech → startap-api:3040) | ✅ | 2026-05-14 |
| WAHA session TESTE_STARTAP webhook → http://startap-api:3040/webhooks/waha (URL Docker interna) | ✅ | 2026-05-14 |
| 11 workflows n8n apagados via API | ✅ | 2026-05-14 |
| Container n8n mantido rodando (vazio, pronto para uso futuro) | ✅ | 2026-05-14 |
| Backup dos workflows em n8n-backup/ no git | ✅ | 2026-05-14 |

## Arquitetura em produção

```
WhatsApp → WAHA (TESTE_STARTAP session)
            │
            └─ webhook: http://startap-api:3040/webhooks/waha (Docker internal)
                          │
                          ▼
                  startap-api (TS, port 3040)
                          │
                          ├─ Router universal (routing_clientes)
                          │
                          ├─ BarbeariaCiriloBot      (workflow_id 0ni38aSspWwhooHd)
                          ├─ RicardoBot              (workflow_id dlpKXM3gvX2joC1b)
                          ├─ StartapAiBot            (workflow_id uUS3Ux1cU2DquKxo)
                          └─ EchoBot                 (template, workflow_id echo)
```

Cron jobs no startap-worker:
- Antibot: a cada 1 minuto (detecta spam)
- Cleanup: a cada 12h (DELETE FROM n8n_chat_histories — Cirilo)

## DNS / Acesso externo (opcional)

O proxy host `api-startap.startap.tech` está criado no NPM mas **não tem DNS A record nem SSL emitido**.

Não é necessário para o funcionamento (WAHA chama internamente). Mas se quiser monitorar /health externo:

1. No Hostinger (DNS `startap.tech`), adicionar A record:
   - Nome: `api-startap`
   - Tipo: A
   - Valor: `187.77.242.220`
2. Aguardar propagação DNS (~10min)
3. No NPM, editar proxy host id 5 → SSL tab → Request a new SSL certificate (Let's Encrypt)

## Rollback (se algo der errado)

```bash
# 1. Voltar webhook WAHA para n8n
ssh root@187.77.242.220 "docker exec automacoes-waha-1 curl -s -X PUT 'http://localhost:3000/api/sessions/TESTE_STARTAP' -H 'X-Api-Key: 0adad70452c443c1834ee6408588f950' -H 'Content-Type: application/json' -d '{\"config\":{\"webhooks\":[{\"url\":\"https://n8n.startap.tech/webhook/router-teste-startap\",\"events\":[\"message\"]}]}}'"

# 2. Restaurar workflows do n8n a partir do backup
API_KEY="<JWT do reference_n8n_credentials.md>"
for f in n8n-backup/*.json; do
  curl -s -X POST 'https://n8n.startap.tech/api/v1/workflows'     -H "X-N8N-API-KEY: $API_KEY"     -H 'Content-Type: application/json'     -d @$f
done
```

## Adicionar novos clientes em produção

```bash
# Cliente da Barbearia Cirilo
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c \"INSERT INTO routing_clientes (telefone, workflow_target, nome_cliente, workflow_id, workflow_name, webhook_url, ativo) VALUES ('5535999XXXXXX', 'cirilo', 'Nome Cliente', '0ni38aSspWwhooHd', 'TESTE_BARBEARIAS_AGENDAMENTOS', 'http://startap-api:3040/webhooks/waha', true) ON CONFLICT (telefone) DO NOTHING;\""

# Cliente do Curso Ricardo
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c \"INSERT INTO routing_clientes (telefone, workflow_target, nome_cliente, workflow_id, workflow_name, webhook_url, ativo) VALUES ('5519XXXXXXXXX', 'ricardo', 'Nome Cliente', 'dlpKXM3gvX2joC1b', 'elenildo.ricardo', 'http://startap-api:3040/webhooks/waha', true) ON CONFLICT (telefone) DO NOTHING;\""
```

## Comandos úteis de manutenção

```bash
# Logs em tempo real
ssh root@187.77.242.220 "docker logs startap-api -f"
ssh root@187.77.242.220 "docker logs startap-worker -f"

# Rebuild após mudança no código
ssh root@187.77.242.220 "cd /opt/automacoes/code && git pull && docker compose build && docker compose up -d"

# Health check (interno)
ssh root@187.77.242.220 "docker exec automacoes-waha-1 curl -s http://startap-api:3040/health"

# Listar quem está roteado
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c 'SELECT telefone, nome_cliente, workflow_name, ativo FROM routing_clientes ORDER BY telefone;'"

# Listar pausas (Cirilo)
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c 'SELECT * FROM pausa_cirilo;'"

# Listar pausas (Ricardo)
ssh root@187.77.242.220 "docker exec automacoes-postgres-1 psql -U n8n_user -d n8n_database -c 'SELECT * FROM pause_ricardo;'"
```
