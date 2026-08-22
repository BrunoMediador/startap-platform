# ADR 0044 — Operação durável de bloqueios recorrentes

- **Status:** Aceito para implementação
- **Data:** 2026-08-22
- **Autor:** arquiteto + backend-senior
- **Relacionados:** ADR 0024, ADR 0031, Missão 033

## Contexto

Criar uma série chama o Google Calendar fora da transação do Postgres. Um timeout ou queda após
o início dessa chamada não informa se o evento foi aceito. Repetir o POST nesse estado pode criar
dois bloqueios. Manter somente um claim `creating` também deixa uma operação órfã sem recuperação.

## Decisão

Uma operação recebe UUID gerado somente no servidor e persiste, antes de chamar o GCal, o plano
canônico de 2--24 ocorrências: ordinal, início/fim UTC e `event_id` determinístico de
`operation_id + ordinal`. O body nunca fornece `serie_id`/operation id.

Estados da operação: `planned`, `creating`, `complete`, `partial`, `recovery_required`,
`failed_final`. Cada ocorrência é `planned`, `gcal_dispatch_started`, `active` ou
`recovery_required`. A transição para `gcal_dispatch_started` é persistida antes da chamada
externa. Só falha comprovada antes desse marcador pode ser reexecutada automaticamente.

Cada claim também incrementa, na mesma statement, um `attempt_version` da operação. O resultado
final só persiste se carrega o último token da operação, e não o máximo de versões individuais
das ocorrências. Isso cerca executor antigo mesmo quando uma recovery v2 de uma ocorrência é
seguida por dispatch v1 de outra.

`POST .../serie/recovery` é autenticado, derivado da mesma sessão e escopado por
tenant+slot+colaborador. Ele consulta o GCal pelo `event_id`: evento encontrado é anexado; não
encontrado após a janela de consistência permite reenvio do mesmo `event_id`; resultado ambíguo
fica em `recovery_required`, nunca vira sucesso fictício.

## Consequências

- Migrations aditivas criam operação/plano e o token de fencing; não há RRULE, fila ou mudança no sync.
- Respostas de replay leem a operação persistida e reproduzem o estado real.
- Rollback quente reverte o código; tabelas ficam inertes. Não aplicar DROP.
