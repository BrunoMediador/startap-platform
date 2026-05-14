# ADR 0002: ConversationScope as the Memory Boundary

## Status

Accepted

## Context

O mesmo telefone pode conversar em contextos diferentes. As tabelas de memoria legadas foram criadas por fluxo e nao representam bem produto, demo, cliente, projeto e ambiente.

## Decision

Introduzir `ConversationScope` como contrato obrigatorio para carregar e salvar historico. A chave logica inclui ambiente, produto, tipo de instancia, instancia, cliente, projeto e telefone.

## Consequences

- Historico de demo e producao fica separado.
- O mesmo telefone pode testar produtos diferentes sem mistura de contexto.
- Clientes e projetos diferentes ficam isolados.
- `BotBase` deve parar de depender de `memoryTable` como fronteira de isolamento.

