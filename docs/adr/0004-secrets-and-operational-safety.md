# ADR 0004: Secrets and Operational Safety

## Status

Accepted

## Context

Credenciais ja apareceram em compose e conversas operacionais. Segredos expostos devem ser tratados como comprometidos.

## Decision

Segredos devem ficar fora do Git e fora do painel. Configuracoes persistidas podem guardar apenas `secret_ref`, apontando para `.env`, Docker secrets, Vault ou outro gerenciador aprovado.

## Consequences

- O painel mostra status, nao segredo.
- Logs precisam mascarar tokens, telefones quando aplicavel e dados sensiveis.
- Rotacao de credenciais vira parte do runbook.
- CI deve evoluir para checagem de segredos no repositorio.

