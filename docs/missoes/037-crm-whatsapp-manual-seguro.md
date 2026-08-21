# Missao 037 - CRM WhatsApp Manual Seguro

**DRI:** backend-senior
**Apetite:** pequeno
**Status:** implementacao backend/db pronta, rollout pendente
**ADR:** [0043 - CRM WhatsApp Manual Seguro](../adr/0043-crm-whatsapp-manual-seguro.md)

## Objetivo

Permitir ao dono enviar manualmente um texto para um unico cliente do seu CRM, pela sessao WAHA
correta do clone. O recurso e pontual e humano: nao cria campanha, fila, agendamento, retry ou
automacao.

## Contrato

- `POST /portal/clientes/:id/whatsapp-manual`, owner-only, recebe somente
  `{ mensagem, confirmed: true }` estrito, trimado e limitado a 1.000 caracteres.
- `slot`, `tenant_id` e `operator_user_id` vem da sessao revalidada; nunca do body ou params.
- O cliente e carregado por `id + slot + tenant_id`; o destino vem de `clientes.telefone_raw` e a
  sessao de `flow_clones.waha_sessao` e o shard de `flow_clones.waha_shard_id`, nunca do slot
  ou do shard default.
- Antes do claim, a rota consulta o clone e aplica o `resolveSilenceGate` canônico: bloqueia
  suspensão Startap e silêncio financeiro, mas não transforma `owner_request` em silêncio total.
- Antes do envio, WAHA recebe typing e espera de 12 segundos; o fetch tem deadline explícito.
- A feature exige `CRM_CLIENTES_ENABLED=true` e `CRM_WHATSAPP_MANUAL_ENABLED=true`. Ausente/OFF
  responde `404 feature_off` antes de CRM, Redis ou WAHA.
- Colaborador e explicitamente negado: a RBAC atual prova somente leitura de atendimentos proprios,
  nao delegacao para contato externo.

## Segurança e Operação

- Guarda SQL atomica por `slot + tenant + operador + cliente` rejeita novo clique durante cooldown.
- Auditoria guarda apenas ids, timestamps, resultado e reason code; nao guarda corpo, telefone,
  resposta da WAHA ou `messageId`.
- Circuit breaker Redis por slot abre apos tres falhas em 60 segundos e recusa envios enquanto
  aberto. Indisponibilidade do Redis fecha o recurso.
- Reserva Redis atômica por slot limita envios em janela curta, além do cooldown por
  operador+cliente; excedente encerra a auditoria como `slot_rate_limited` e não chega à WAHA.
- Sem bulk, lista de destinatarios, upload, template, schedule, worker, cron ou retry.

## Definition of Done

- [x] Flag default OFF e timeout/cooldown configurados com defaults seguros.
- [x] Query parametrizada e escopo por `slot + tenant_id` em alvo, claim e auditoria.
- [x] Sessao e shard WAHA vêm de `flow_clones.waha_sessao` e `waha_shard_id`.
- [x] Contrato integrado usa `POST /portal/clientes/:id/whatsapp-manual` com confirmação explícita.
- [x] Gate operacional e limite atômico Redis bloqueiam envio antes da WAHA.
- [x] Typing/humanizacao e timeout WAHA sao server-side.
- [x] Unit cobre caminho feliz, flag/texto invalido, colaborador, cooldown e WAHA indisponivel.
- [ ] QA/security revisam a PR; PM decide se o rollout permanece OFF ou piloto ON.

## Rollback

Manter/remover `CRM_WHATSAPP_MANUAL_ENABLED` devolve 404 imediato. Reverter a PR e manter a
migration aditiva nao apaga auditoria nem dados de CRM.
