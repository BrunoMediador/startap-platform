# Missao 036 - CRM Aniversariantes Read-only

**DRI:** arquiteto + backend-senior
**Apetite:** medio
**Status:** proposta documentada; sem codigo de app/db/frontend nesta branch
**ADR:** [0042 - CRM Aniversariantes Read-only](../adr/0042-crm-aniversariantes-readonly.md)
**Base consultada:** CRM Clientes e Ranking Sem Retorno integrados ate PR #591

## PR-FAQ

### Press release

A Startap passa a mostrar no CRM uma lista read-only de clientes com aniversario cadastrado. O dono
consegue ver os aniversariantes da carteira autorizada; cada colaborador ve somente clientes ligados
a seus proprios atendimentos. A lista usa telefone mascarado e nao dispara mensagens.

Esta fatia ajuda o atendimento humano a lembrar datas importantes sem criar automacao, WhatsApp,
exportacao, enriquecimento de dados ou backfill.

### FAQ

**De onde vem o aniversario?** Do campo opcional `clientes.aniversario_mmdd`, preenchido
manualmente no perfil CRM. A Startap nao infere aniversario por conversa, agenda ou historico.

**Vai guardar data de nascimento completa?** Nao. A fatia guarda apenas mes e dia (`MM-DD`), sem
ano e sem idade.

**Quem pode editar?** A edicao continua owner-only pelo perfil CRM existente. Colaborador ve a lista
em read-only e nao altera aniversario.

**Quem ve quais clientes?** Dono ve a carteira CRM do tenant/slot autorizado pelo portal.
Colaborador ve somente clientes com atendimento proprio no mesmo `slot + tenant_id`.

**Qual janela existe?** A API suporta aniversarios dos proximos dias (`1..31`) e aniversarios de um
mes calendario (`1..12`), calculados no timezone do slot obtido no servidor.

**Vai mandar parabens no WhatsApp?** Nao. WhatsApp, automacao, lembrete, campanha, exportacao e IA
ficam fora de escopo.

**Quando liga em producao?** O codigo nasce com `CRM_ANIVERSARIANTES_ENABLED` default OFF e so liga
globalmente depois de CI verde, reviews QA/security e smoke humano.

## Escopo

- Lista read-only baseada em `clientes.aniversario_mmdd`.
- Data manual, opcional, sem ano e sem backfill.
- `GET /portal/clientes/aniversariantes` para dono.
- `GET /portal/colaborador/clientes/aniversariantes` para colaborador.
- Janelas `modo=proximos` com `dias <= 31` e `modo=mes` com `mes=1..12`.
- Timezone server-side do slot/tenant; nenhum timezone aceito do cliente HTTP.
- Paginacao inicial por offset com `limit <= 50` e `offset <= 100`.
- Lista com PII minima: `id`, `nome`, `telefone_masked`, `aniversario_mmdd`, proxima ocorrencia e
  dias ate aniversario quando aplicavel.
- Flag `CRM_ANIVERSARIANTES_ENABLED` default OFF; OFF retorna 404 `feature_off`.
- Migration aditiva apenas para indice de leitura por `slot + tenant_id + aniversario_mmdd`.

## Fora de Escopo

- Editar app, db ou frontend nesta branch documental.
- WhatsApp manual, mensagem de parabens, automacao, broadcast, campanha, lembrete ou fila.
- Exportacao CSV/Excel/API externa.
- Backfill, seed, importacao, enriquecimento e lazy upsert em qualquer GET.
- Armazenar ano de nascimento, idade ou data completa de nascimento.
- Permitir edicao por colaborador.
- Usar aniversario em ranking comercial, score, IA, prompt ou metrica individual.

## Contratos

### API

- `GET /portal/clientes/aniversariantes` usa `withTenant`.
- `GET /portal/colaborador/clientes/aniversariantes` usa `withColaborador`.
- Query schema `.strict()` aceita somente `modo`, `dias`, `mes`, `limit` e `offset`.
- `modo=proximos` default: `dias` default 30, minimo 1, maximo 31.
- `modo=mes`: `mes` obrigatorio, minimo 1, maximo 12; `dias` rejeitado.
- `limit` minimo 1, maximo 50; `offset` minimo 0, maximo 100.
- OFF por flag retorna 404 `feature_off` antes de consulta pesada.
- Resposta nao inclui links ou acoes de envio.

### Dados

- Fonte unica: `clientes.aniversario_mmdd` ja existente.
- Nenhuma coluna nova de PII para esta fatia.
- Query sempre inclui `clientes.slot = $slot` e `clientes.tenant_id = $tenantId`.
- Colaborador exige atendimento proprio por `EXISTS`/join em `atendimentos` com
  `colaborador_id = $colaboradorId`, `slot` e `tenant_id`.
- Datas impossiveis em formato valido (`02-31`, por exemplo) sao ignoradas pela lista e nao causam
  erro 500.
- `02-29` so entra em janela que contenha um 29 de fevereiro real; nao normalizar.
- GET nao cria cliente, nao altera aniversario e nao atualiza snapshot de atendimento.

### RBAC

- Dono: escopo derivado por `withTenant` e `getScopeBySlot`; nada de `slot`/`tenant_id` no input.
- Colaborador: read-only; `colaborador_id` vem da sessao revalidada.
- Falha de escopo retorna 404 generico quando houver lookup por `cliente_id` em evolucao futura.
- Filtro de colaborador deve existir no SQL, nao apenas na camada de UI.

### LGPD e Logs

- Telefone sempre mascarado na lista.
- Nao retornar telefone cru, telefone canonico, `telefone_raw`, `cidade`, `nota_interna`,
  historico, observacao, GCal, WhatsApp ou payload externo.
- Logs sem nome, telefone, aniversario individual ou nota.
- Metricas permitidas: contagem, duracao, modo, limit/offset validos e reason codes sem PII.

### Migracao

- Migration aditiva esperada: indice parcial em `clientes (slot, tenant_id, aniversario_mmdd, id)`
  com `WHERE aniversario_mmdd IS NOT NULL`.
- Se `deleted_at` existir quando a fatia for codada, aplicar `deleted_at IS NULL` na query e no
  indice parcial.
- Nao criar migration de backfill e nao apertar constraint de calendario sem auditoria previa.

## Riscos

| Risco | Mitigacao |
|---|---|
| lista virar campanha de parabens | WhatsApp, automacao, exportacao e fila fora de escopo |
| vazamento cross-tenant | `slot + tenant_id` obrigatorios e derivados do servidor |
| colaborador ver carteira alheia | `EXISTS`/join com atendimento proprio no SQL |
| exposicao de PII sensivel | telefone mascarado, sem ano, sem nota e sem logs com PII |
| DoS por varredura mensal | flag OFF, `limit <= 50`, `offset <= 100`, indice parcial |
| data invalida quebrar API | helper/teste exclui data impossivel sem 500 |
| divergencia de fuso | calculo usa timezone do slot no servidor |

## Definition of Done

- [ ] ADR 0042 revisado antes de qualquer codigo.
- [ ] Flag `CRM_ANIVERSARIANTES_ENABLED` default OFF e dependente de `CRM_CLIENTES_ENABLED`.
- [ ] OFF retorna 404 `feature_off` antes de tocar DB caro.
- [ ] Query schema `.strict()` rejeita parametro desconhecido e campos de escopo.
- [ ] Owner recebe somente linhas do proprio `slot + tenant_id`.
- [ ] Colaborador recebe somente clientes com atendimento proprio.
- [ ] Lista nao contem telefone cru/canonico, `telefone_raw`, `cidade`, `nota_interna` ou historico.
- [ ] Teste cobre `modo=proximos`, `modo=mes`, virada de ano, borda de meia-noite e `02-29`.
- [ ] Teste cobre data impossivel sem 500 e sem inclusao na lista.
- [ ] Teste cobre GET sem seed/backfill/upsert/mutation.
- [ ] Teste cobre `limit=50`, `limit=51`, `offset=100`, `offset=101`, `dias=31`, `dias=32`.
- [ ] SQL parametrizado; nenhum input do usuario concatena consulta.
- [ ] Indice parcial comprovado por teste SQL ou `EXPLAIN`.
- [ ] Reviews QA e security aprovam RBAC, LGPD, performance e flag.
- [ ] CI completo verde antes de merge.
- [ ] Smoke humano no portal antes de ligar globalmente.
- [ ] Rollout global so depois de CI, reviews e smoke, medindo env real do container.

## Rollback

1. Manter `CRM_ANIVERSARIANTES_ENABLED=false` ou remover a env para voltar ao default OFF.
2. Se ja houver codigo, reverter a PR sem apagar dados de CRM.
3. Migration aditiva de indice pode permanecer inerte em rollback quente.
4. Validar que CRM Clientes e Ranking Sem Retorno seguem respondendo conforme suas flags.
