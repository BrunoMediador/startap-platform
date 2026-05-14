# Backup dos Workflows n8n (snapshot 2026-05-14)

Snapshot completo dos 11 workflows que estavam no n8n antes do cutover para o TS platform.

Para restaurar um workflow:

```bash
curl -X POST 'https://n8n.startap.tech/api/v1/workflows'   -H 'X-N8N-API-KEY: $API_KEY'   -H 'Content-Type: application/json'   -d @TESTE_BARBEARIAS_AGENDAMENTOS__0ni38aSspWwhooHd.json
```

> Nota: Credenciais (Google, OpenAI, DeepSeek, WAHA, Postgres) NÃO estão no JSON — apenas referências por ID. Você precisa recriar as credenciais no n8n se for restaurar.
