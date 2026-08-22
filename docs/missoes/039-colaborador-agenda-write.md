# Missão 039 — Escrita de agenda pelo colaborador

**DRI:** backend-senior
**Apetite:** pequeno
**Status:** implementação
**ADR:** 0045

## PR-FAQ

### Press release

Em estabelecimentos, cada colaborador passa a criar, remarcar e cancelar somente os horários da
própria agenda. O dono continua operando todas as agendas de seu estabelecimento. A mesma
validação de disponibilidade, horário de funcionamento e espelho financeiro usada pela empresa é
aplicada às ações do colaborador.

### FAQ

**Q: Por que uma rota separada?**
**A:** As rotas do dono aceitam a agenda alvo para atender todos os profissionais. A sessão de
colaborador nunca deve poder nomear esse alvo; as novas rotas derivam-no da credencial revalidada.

**Q: Um colaborador pode editar ou cancelar o evento de outro?**
**A:** Não. PATCH e DELETE consultam apenas o calendário associado ao `colaboradorId` da sessão.
Um identificador de colega ou de outro tenant retorna o mesmo 404 de evento ausente.

**Q: O faturamento acompanha as mudanças?**
**A:** Sim. Criar e remarcar mantêm o upsert/sync de `atendimentos`; cancelar mantém o soft-delete
idempotente. A auditoria diferencia `portal:<ownerId>` de `portal:colaborador:<colaboradorId>`.

**Q: Por que há dois gates?**
**A:** `COLABORADOR_PORTAL_ENABLED` controla a autenticação/painel. A escrita é uma capability
distinta e nasce OFF em `COLABORADOR_AGENDAMENTOS_ENABLED`; a allowlist
`COLABORADOR_AGENDAMENTOS_SLOTS` permite rollback imediato e rollout explícito com `*`.

## Escopo

- POST, PATCH e DELETE em `/portal/colaborador/agendamentos[/:eventId]`.
- GET de serviços, horários e slots sob `/portal/colaborador/agendamentos/*`, mais o sinal
  explícito `agenda_write_enabled` na leitura da agenda.
- Agenda e profissional derivados somente da sessão do colaborador.
- Reuso do núcleo de comandos do dono: fuso, serviço, conflito, event ID e espelho total.
- Flag global e allowlist por slot, ambas fail-closed.

## Fora de escopo

- Séries/recorrência, mover evento entre colaboradores e mudanças de frontend.
- Restringir serviços ao subconjunto atribuído ao colaborador: o owner hoje usa o catálogo global;
  mudar essa regra exige decisão de produto específica.
- Migration ou mudança de schema.

## Definition of Done

- [x] POST estrito rejeita `colaborador_id` do browser.
- [x] PATCH/DELETE não listam nem tocam a agenda de colega.
- [x] Owner preserva o comportamento e a auditoria legada.
- [x] Colaborador preserva conflito, event ID e espelho para faturamento.
- [x] Flag e allowlist retornam 404 antes de GCal.
- [x] Leituras de suporte usam a mesma capability; slots rejeitam `colaborador_id` e consultam
  exclusivamente a agenda da sessão.
- [ ] Frontend adiciona controles e smoke humano em navegador.
- [ ] PM/DevOps mede env no container e liga os gates globais após merge.

## Rollback

Definir `COLABORADOR_AGENDAMENTOS_ENABLED=false` ou remover o slot da allowlist interrompe as
ações sem afetar a leitura de agenda, o login do colaborador nem as rotas do dono. Reverter o
código é seguro e não requer migration.
