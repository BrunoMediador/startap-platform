# Missão 038 — Operação durável de bloqueios recorrentes

**DRI:** backend-senior  
**Apetite:** médio  
**Status:** em implementação  
**ADR:** 0044

## Objetivo

Eliminar replays que duplicam eventos GCal e permitir recuperar operações interrompidas sem
relançar efeitos externos ambíguos.

## Definition of Done

- plano ordinal persistido antes do GCal, com event id determinístico;
- owner/colaborador continuam escopados por sessão/tenant/slot;
- timeout e cleanup timeout vão a `recovery_required`, sem retry HTTP;
- recovery consulta evento por id antes de reenviar;
- token de fencing da operação impede executor vencido sem bloquear recovery multiocorrência;
- testes cobrem sucesso, timeout, cleanup timeout, crash entre ocorrências, concorrência e recovery;
- migration aditiva não aplicada durante a implementação.

## Rollback

Reverter código; conservar dados de operação para auditoria e recuperação. Sem DROP/DELETE/TRUNCATE.
