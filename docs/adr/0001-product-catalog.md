# ADR 0001: Product Catalog and Versioned Product Behavior

## Status

Aceita

## Context

Os bots atuais ainda carregam prompt, videos, precos, horarios e regras no codigo. Isso torna a operacao dependente de deploy para mudancas comerciais simples.

## Decision

Criar catalogo de produtos com versoes publicaveis. Produtos representam modelos homologados. Versoes representam snapshots imutaveis de prompt, regras, ferramentas, dados demo e configuracao de modelo.

## Consequences

- Demos e clientes podem apontar para uma versao especifica.
- Mudancas em produto ativo exigem nova versao.
- O painel pode editar rascunhos sem afetar producao.
- O codigo do bot passa a executar comportamento, nao guardar dados comerciais.

