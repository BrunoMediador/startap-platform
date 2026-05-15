# ADR 0003: Router for Demos, Direct Resolution for Production

## Status

Accepted

## Context

O router atual funciona para testes, mas mistura o conceito de prospect/demo com operacao de cliente real. Isso aumenta risco de vazamento de contexto e dificulta escalar clientes isolados.

## Decision

Manter `routing_clientes` apenas para demo comercial. Em producao, resolver cliente e projeto pela sessao WAHA e pelas integracoes cadastradas.

## Consequences

- O comercial continua liberando testes rapidamente.
- Cliente real nao depende da tabela de prospects.
- Cada cliente pode ter sessao WAHA propria.
- O wizard de clone precisa provisionar instancia, integracoes e escopo de producao.

