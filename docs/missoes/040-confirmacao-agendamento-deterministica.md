# Missão 040 — Confirmação de agendamento determinística

**DRI:** backend-senior · **Apetite:** P1 · **Estado:** implementação, OFF

## PR-FAQ

**O que muda?** O modelo deixa de criar o evento diretamente quando o guard está ligado: propõe
dados estruturados, o servidor manda cartão completo e só SIM literal confirma.

**Quem é afetado agora?** Ninguém. A allowlist vem vazia; não houve mensagem, teste, alteração
de credencial ou configuração do Doctor Barber.

**Como evita duplicidade?** HMAC por contato + CAS persistido + `eventId` determinístico + GET
de recovery, sem segundo POST após timeout ambíguo.

**Como preserva cartões?** Runtime usa `buildCartaoExemplo`, a mesma fonte canônica. Baked usa
apenas um contrato explícito por slot (`literal|field`, cinco campos canônicos e hash do cartão
revisado); sem ele continua inativo, sem fallback genérico.

## Definition of Done

- [x] Migration aditiva com tenant, slot, HMAC, TTL e estados finitos.
- [x] Proposta, cartão e confirmação server-first no estabelecimento runtime, por allowlist OFF.
- [x] CAS, conflito, retry SIM e timeout ambíguo em testes unitários.
- [x] Action-lock sem telefone em chave/log Redis.
- [x] Job de retenção terminal finita, em DRY-RUN por padrão.
- [x] Contrato baked versionado, com hash-precondição e golden redigido Doctor Barber.
- [x] Hash baked alterado após cartão invalida o pending e bloqueia fallback legado.
- [x] Dry-run que imprime apenas hashes/contadores/status para validar contrato futuro.
- [ ] Teste de integração PostgreSQL 16 com `PG_TEST_URL`.
- [ ] Revisão manual do literal e transação futura de snapshot/contrato/rollout por slot.
- [ ] QA/security review e canário Dragon de 48h antes de qualquer GO de cliente.

## Riscos aceitos / próximo incremento

O contrato não é autoextraído nem aplicado nesta entrega. O PM ainda precisa transcrever a copy
aprovada em segmentos, obter o hash pelo dry-run e executar a transação futura; Doctor Barber
segue OFF. A tabela guarda somente dado pseudonimizado; o job de limpeza opera em DRY-RUN até um
GO explícito para remoção física.
