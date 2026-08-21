# ADR 0043 - CRM WhatsApp Manual Seguro

**Status:** Proposto
**Data:** 2026-08-21
**Missao:** [037 - CRM WhatsApp Manual Seguro](../missoes/037-crm-whatsapp-manual-seguro.md)

## Contexto

O CRM canônico permite identificar um cliente por tenant e telefone, mas o ranking e o perfil
eram deliberadamente read-only quanto a contato. Um envio manual reduz a friccao operacional, mas
é uma acao externa com risco de PII, duplo clique, sessao WAHA errada e abuso por colaboradores.

## Decisao

Criar uma unica rota owner-only, `POST /portal/clientes/:id/whatsapp`, atras de duas flags:
`CRM_CLIENTES_ENABLED` e `CRM_WHATSAPP_MANUAL_ENABLED`, ambas OFF por ausencia.

O texto e o unico campo aceito. O backend revalida a sessao, resolve `slot`, `tenant_id` e owner,
busca o cliente no mesmo escopo e resolve a sessao exclusivamente por `flow_clones.waha_sessao`.
O slot nunca e usado como nome de sessao WAHA.

Todo envio aplica `startTyping`, espera fixa de 12 segundos e `sendText`; a chamada recebe
`AbortSignal.timeout`. Falha de envio encerra o typing em best effort e retorna erro generico.

## RBAC

Dono pode enviar somente a cliente pertencente ao seu `slot + tenant_id`. Colaborador nao recebe
endpoint: a autorizacao existente do colaborador e read-only por atendimentos proprios e nao e
evidencia de delegacao segura para representar a empresa em contato externo. Uma futura permissao
exige modelo de delegacao, revogacao e auditoria propria antes de abrir esse acesso.

## Idempotencia, Auditoria e Resiliencia

Uma tabela de guarda possui chave primaria por `slot, tenant_id, cliente_id, operator_user_id`.
`INSERT ... ON CONFLICT ... WHERE cooldown_until <= NOW()` faz o claim atomico e cria a auditoria
somente para o vencedor. O perdedor recebe `409 cooldown_ativo` e nunca chama WAHA.

A auditoria guarda ids, timestamps, estado e reason code. Mensagem, telefone, resposta WAHA e id
da mensagem nao sao persistidos nem logados. Logs estruturados incluem `slot` e `request_id`.

Circuit breaker Redis e compartilhado por slot: tres falhas em 60 segundos abrem por 60 segundos.
Falha do Redis nega novo envio, preservando comportamento fail-closed.

## Consequencias

O recurso nao suporta lista, bulk, campanha, importacao, template, arquivo, agendamento, fila,
cron ou retry. Timeout e ambiguidade de rede podem significar que a WAHA aceitou a mensagem antes
da resposta; por isso o cooldown permanece e a resposta nunca declara entrega quando falha.

A migration e estritamente aditiva. Rollback quente e desligar a flag; rollback de codigo pode
manter as tabelas inertes, sem DELETE ou DROP.
