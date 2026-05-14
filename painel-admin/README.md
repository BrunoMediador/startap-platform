# Painel Admin

UI para vincular telefones a bots (atualiza tabela `routing_clientes`).

Roda como container Docker separado (`automacoes-painel-admin-1`) e mostra os 3 bots do TS platform como opções selecionáveis.

## Build/Deploy

```bash
cd /opt/automacoes && docker compose build painel-admin && docker compose up -d painel-admin
```

## Acesso
- URL: https://gestao.startap.tech (via NPM)
- Auth: basic auth (usuário admin / senha startap2026)

## Bots disponíveis (hardcoded em server.js)
- `0ni38aSspWwhooHd` → BarbeariaCiriloBot
- `dlpKXM3gvX2joC1b` → RicardoBot
- `uUS3Ux1cU2DquKxo` → StartapAiBot

Adicione novos bots editando a constante `TS_BOTS` em `server.js` e rebuildando.
