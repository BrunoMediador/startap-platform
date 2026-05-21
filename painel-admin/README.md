# Painel Admin

UI para vincular telefones a bots (atualiza tabela `routing_clientes`).

Roda como container Docker separado (`automacoes-painel-admin-1`) e mostra os 3 bots do TS platform como opções selecionáveis.

## Build/Deploy

```bash
cd /opt/automacoes && docker compose build painel-admin && docker compose up -d painel-admin
```

## Upload de mídias

O painel permite cadastrar mídias por URL ou enviar um arquivo local para o servidor.

- `caption`: texto enviado junto da mídia para o cliente no WhatsApp.
- `context`: contexto interno para a IA decidir quando a mídia deve ser usada; esse texto não é enviado ao cliente.
- `MEDIA_STORAGE_DIR`: diretório onde o painel grava uploads.
- `MEDIA_PUBLIC_BASE_URL`: base pública usada para salvar a URL no banco.
- `MEDIA_UPLOAD_MAX_MB`: limite por arquivo, em MB.

No servidor atual, os uploads devem ficar no mesmo diretório servido pelo container `nginx-videos`.
O painel precisa ter volume de escrita para `/opt/automacoes/videos` e salvar URLs compatíveis com o WAHA.

## Variáveis de ambiente obrigatórias

As variáveis abaixo são lidas via `process.env` — **nunca** usar valores hardcoded.
Consulte `.env.example` para a lista completa.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PG_PASS` | sim | Senha do Postgres — processo aborta no boot se ausente |
| `ADMIN_PASS` | sim | Senha do basic-auth do painel (min. 8 chars, `!= admin`) |
| `GCAL_ENCRYPTION_KEY` | sim | Chave AES-256 para credenciais GCal at-rest |
| `ADMIN_USER` | não | Username do basic-auth (default: `admin`) |
| `WAHA_API_KEY` | não | API key do WAHA (default: vazio) |

## Acesso
- URL: https://gestao.startap.tech (via NPM)
- Auth: basic auth — credenciais definidas via `ADMIN_USER` / `ADMIN_PASS` no `.env` do servidor.
  Nunca compartilhar a senha em documentação; consultar Bruno ou o `.env` no servidor.

## Bots disponíveis (hardcoded em server.js)
- `0ni38aSspWwhooHd` → BarbeariaCiriloBot
- `dlpKXM3gvX2joC1b` → RicardoBot
- `uUS3Ux1cU2DquKxo` → StartapAiBot

Adicione novos bots editando a constante `TS_BOTS` em `server.js` e rebuildando.
