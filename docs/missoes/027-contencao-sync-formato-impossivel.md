# Missão 027 — Contenção P0 do sync em formato incoerente

**DRI:** backend-senior

**Agentes envolvidos:** backend-senior (contenção e testes), qa-tester (suíte/build), security (review de integridade financeira)

**Apetite:** pequeno (uma PR, sem migration e sem transição completa de formato)

**Status:** contenção implementada localmente; sem push, PR, merge ou deploy
**ADRs:** 0026, 0031 e 0034

---

## Problema e causa

O formato do clone é um agregado parcial. O runtime considera o modo efetivo atendente quando o gate
`modo_atendente_enabled` (env ou coluna) está ligado e `personalizacao.agenda_automatica` é `false`.
O `gcal-atend-sync`, porém, enumerava clones somente pelo gate independente
`billing_from_agenda_enabled` (env ou coluna). Assim, uma meia-transição podia deixar atendente e sync
ligados ao mesmo tempo; o cron continuava reconciliando e podia soft-deletar faturamento que o modo
atendente não deveria mais espelhar.

O primeiro guard de seleção ainda deixava um TOCTOU: depois de selecionar um clone em agenda, o job
aguarda GCal e outras leituras. Nesse intervalo, uma transição agenda→atendente podia commitar; o
snapshot antigo então chegava aos helpers de escrita e ainda fazia upsert/soft-delete, inclusive pago.

Evidência sanitizada recebida na abertura do P0: 381 atendimentos vivos estavam sob essa combinação
de estado em produção. Esta missão não acessa nem altera produção e não contém slot, telefone, nome,
event id ou outro dado de cliente.

## Objetivo

Falhar fechado antes de qualquer leitura do Google Calendar ou escrita em `atendimentos`: clone em
modo efetivo atendente não é reconciliado, mesmo se o gate legado do sync ainda estiver ligado.

## Escopo

- Excluir modo efetivo atendente na query que enumera o sync, considerando env e coluna.
- Repetir o predicado no worker antes de preço, GCal, upsert ou soft-delete (defesa em profundidade).
- Condicionar cada upsert/soft-delete ao modo atual dentro da própria statement SQL e serializar com
  a transição por `SELECT ... FOR UPDATE` na linha do clone.
- Exigir `origem='agenda'` novamente na statement do soft-delete, preservando edição manual que
  ocorra depois da seleção de candidatos.
- Preservar explicitamente todo atendimento nesse estado, inclusive linha paga.
- Manter a regra do ADR 0031 para clones efetivamente em agenda: espelho total, inclusive pagos.
- Adicionar `MODO_ATENDENTE_SLOTS` ao config opcional do worker, com default vazio.

## Fora de escopo

- Implementar a operação transacional das oito variáveis do ADR 0034.
- Corrigir ou backfillar combinações incoerentes em produção.
- Alterar `billing_from_agenda_enabled`, prompt, cartão, GCal, schema ou dados existentes.
- Mudar a regra de espelho total para clones efetivamente em agenda.

## Definition of Done (DoD)

- [x] Teste vermelho prova que modo efetivo atendente alcançava soft-delete de atendimento pago.
- [x] O mesmo teste fica verde e prova zero acesso a preço, GCal, candidatos, upsert ou soft-delete.
- [x] A seleção SQL cobre gate atendente por coluna, lista da env e wildcard, sempre escopada por slot.
- [x] Ausência de `agenda_automatica` conserva o default agenda e não exclui o clone por `NULL` SQL.
- [x] Config nova é opcional; env ausente não impede boot do worker.
- [x] Teste concorrente vermelho→verde muda agenda→atendente durante o `await` do GCal e prova zero
  upsert e zero soft-delete persistidos.
- [x] Integração PostgreSQL 16 real prova espera pelo lock, reavaliação após a transição e preservação
  da linha paga; cluster local temporário foi parado e removido após o teste.
- [x] Testes focados, build e suíte completa verdes.
- [ ] Review de qa-tester e security antes de qualquer merge.

## Riscos

- **Sub-reconciliação por falso positivo:** um clone de agenda poderia ser pulado. Mitigação: o
  predicado exige simultaneamente gate atendente efetivo e `agenda_automatica=false`; ausência/`true`
  continua agenda, com `COALESCE(..., FALSE)` explícito na SQL.
- **Drift entre query e worker:** os guards poderiam divergir. Mitigação: seleção e worker usam os
  mesmos três inputs, mas a autoridade final é a statement de escrita sob lock; testes cobrem as três.
- **Contenção de lock:** uma transição e o sync do mesmo slot podem esperar um pelo outro. Mitigação:
  lock por uma única statement curta, escopada ao `slot`; clientes diferentes não se bloqueiam.
- **Mudança concorrente de formato:** a contenção reduz, mas não torna as oito variáveis atômicas.
  A solução definitiva permanece a operação transacional do ADR 0034.

## Rollback

Reverter a única PR. Não há migration, backfill nem estado novo. O rollback restaura a enumeração
anterior do cron; não requer alteração de dados. Como contenção operacional adicional, desligar
`GCAL_ATEND_SYNC_ENABLED` remove o cron inteiro, mas qualquer ação em produção fica fora desta missão.
