# ADR 0045 — RBAC de escrita de agenda pelo colaborador

- **Status:** aceito para implementação
- **Data:** 2026-08-22
- **Relacionados:** ADR 0023, ADR 0024, ADR 0027

## Contexto

O colaborador autenticado já lê apenas a própria agenda, mas os comandos de agenda pertenciam às
rotas do dono. Reusar essas rotas concederia poder de escolher qualquer profissional; duplicar os
comandos faria validações de disponibilidade e o espelho financeiro divergirem.

## Decisão

As rotas de colaborador usam `withColaborador` e chamam o mesmo núcleo de create/patch/delete do
dono com uma policy de ator. Para o owner, a policy permite resolver qualquer agenda do slot. Para
o colaborador, a policy força `colaboradorId` da sessão, filtra `getGcalsForSlot(slot)` antes de
listar eventos e jamais aceita `colaborador_id` no POST.

PATCH e DELETE retornam `evento_nao_encontrado` tanto para evento ausente quanto para evento de
colega/outro tenant. O cancelamento preserva `portal:<ownerId>` para owner e grava
`portal:colaborador:<colaboradorId>` para colaborador em `deleted_by`.

A capability nasce protegida por `COLABORADOR_AGENDAMENTOS_ENABLED` e
`COLABORADOR_AGENDAMENTOS_SLOTS`; ausência de qualquer um falha fechada com 404.

As leituras que suportam a escrita (serviços, horários e slots) usam a mesma capability. Serviços
e horários preservam o catálogo compartilhado do estabelecimento, por paridade com o owner; a
resolução de slots força a agenda da sessão e rejeita `colaborador_id` no query string. O GET da
agenda expõe `agenda_write_enabled` calculado no servidor para que a UI nunca infira permissão.

## Consequências

- Não há migration: o vínculo agenda-colaborador e a trilha `deleted_by` já existem.
- As rotas do dono seguem com `withTenant`, que continua bloqueando sessão de colaborador.
- Recorrência e transferência de profissional permanecem fora da fatia.
- A atribuição de serviços por colaborador permanece fora da fatia; o catálogo global é uma
  decisão de produto explícita e não uma concessão de acesso à agenda de colegas.
