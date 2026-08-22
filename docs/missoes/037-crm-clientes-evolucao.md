# Missão 037 — CRM Clientes: evolução de carteira

**DRI:** backend-senior + frontend-engineer  
**Apetite:** médio  
**ADR:** [0043](../adr/0043-crm-clientes-carteira-e-avatar-privado.md)

## Resultado

A aba Clientes consulta a carteira com filtros server-side, resumo, calendário de aniversários,
ranking existente e edição owner-only do nome apresentado, sem ampliar o envio manual individual.

## Contratos backend

- `GET /portal/clientes`: `nome`, `telefone`, `ultimo_atendimento`, `periodo_inicio`,
  `periodo_fim`, `visitas`, `ordenar_por`, `ordem`, `limit`, `offset`; `q` permanece legado.
- `GET /portal/clientes/resumo` e equivalente colaborador, todos escopados pela sessão.
- `GET /portal/clientes/aniversariantes?modo=calendario&visao=semana|mes&ancora=YYYY-MM-DD`.
- `PATCH /portal/clientes/:id` aceita `nome_personalizado` owner-only; `null`/vazio remove.
- `GET /portal/clientes/:id/avatar` é proxy autenticado owner-only, responde imagem privada ou
  `204`; não entrega URL remota.

## Fora de escopo

Bulk, campanhas, automação, agendamento/retry de mensagens, foto persistida, CDN pública, coleta
de foto em massa e liberar WhatsApp/foto para colaborador.

## Definition of Done

- [ ] Filtros combinam por E no PostgreSQL, ordenação é estável e telefone de lista é mascarado.
- [ ] Atendimento futuro/cancelado/apagado não altera visitas/último atendimento elegíveis.
- [ ] Calendário semana/mês preserva timezone de tenant e trata datas inválidas sem 500.
- [ ] Personalização não reescreve `clientes.nome`; colaborador não possui PATCH.
- [ ] Avatar reautoriza, usa Redis TTL, não vaza URL/telefone e 204 não quebra a lista.
- [ ] Migration aditiva/manifest, testes unitários e EXPLAIN real no CI estão verdes.
