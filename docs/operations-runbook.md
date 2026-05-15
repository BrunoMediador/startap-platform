# Operations Runbook

## Fluxo de Mudanca

1. Criar branch a partir de `main`.
2. Implementar mudanca pequena e revisavel.
3. Rodar `npm ci`, `npm run build`, `npm test` e `npm run lint`.
4. Abrir PR para `main`.
5. Aguardar CI e review.
6. Fazer merge.
7. Rodar deploy oficial.
8. Validar health checks e smoke tests.

## Checklist de Deploy

- Confirmar que o commit esperado esta em `main`.
- Confirmar que nao ha migracao destrutiva sem backup.
- Rodar backup quando a mudanca tocar schema ou dados criticos.
- Aplicar migracoes.
- Rebuildar containers.
- Subir stack.
- Validar `/health`.
- Validar recebimento de webhook WAHA em demo.
- Validar um fluxo comercial critico.
- Registrar incidente se houver rollback ou hotfix.

## Rollback

Rollback de codigo:

1. Reverter o commit ruim via PR ou hotfix.
2. Fazer deploy oficial.
3. Validar health checks.

Rollback com migracao:

1. Avaliar se a migracao e reversivel.
2. Se houver perda de dados, restaurar backup aprovado.
3. Desativar produto, demo ou cliente afetado pelo painel quando possivel.

## Segredos

- `.env` nunca deve ser versionado.
- `docker-compose.yml` nao deve conter senhas reais.
- Tokens expostos devem ser rotacionados.
- O painel pode mostrar status de integracao, mas nao tokens.
- Logs devem ocultar credenciais e dados pessoais desnecessarios.

## Observabilidade

Logs de processamento devem carregar:

- `environment`
- `product_id`
- `instance_id`
- `client_id`
- `project_id`
- `user_phone_hash`
- `waha_session`
- `message_id`
- `bot_name`

Metricas recomendadas:

- Mensagens por produto, demo, cliente e projeto.
- Tempo medio de resposta.
- Erros por bot.
- Uso de tokens e custo por cliente/projeto.
- Falhas WAHA.
- Falhas Google Calendar.
- Leads gerados.
- Agendamentos criados.

## Smoke Tests

Antes de encerrar um deploy, validar:

- API responde `/health`.
- Worker esta rodando.
- Postgres esta acessivel.
- Redis esta acessivel quando usado.
- WAHA session esperada esta online.
- Demo de Curso recebe e responde.
- Demo de Barbearia recebe e responde.
- Logs nao mostram token ou stack trace sensivel.

