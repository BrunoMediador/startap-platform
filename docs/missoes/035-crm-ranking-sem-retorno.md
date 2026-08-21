# Missao 035 - CRM Ranking Sem Retorno

**DRI:** arquiteto + backend-senior
**Apetite:** medio
**Status:** proposta documentada; sem codigo de app/db/frontend nesta branch
**ADR:** [0041 - CRM Ranking Sem Retorno](../adr/0041-crm-ranking-sem-retorno.md)
**Base:** origin/main `68841e2`

## PR-FAQ

### Press release

A Startap passa a mostrar, dentro do CRM, uma lista priorizada de clientes que ja foram atendidos e
nao voltaram. O dono enxerga a carteira inteira da empresa; cada colaborador enxerga somente
clientes dos seus proprios atendimentos. A lista e read-only, com telefone mascarado e sem envio de
mensagens.

Esta fatia ajuda o operador a decidir quem merece atencao humana, sem automatizar contato, sem
exportar dados e sem ampliar a superficie de PII do CRM.

### FAQ

**Por que fazer depois da base canonica?** Porque o ranking precisa de identidade estavel por
`tenant_id + telefone_canonico`. Nome livre em `atendimentos` nao e chave segura.

**O que conta como "sem retorno"?** Apenas atendimento ativo, nao cancelado, concluido/passado e
ligado a cliente canonico. Agenda usa `COALESCE(fim_at, inicio_at)`; manual usa `data`. Futuro
nunca entra.

**Quem ve o que?** Dono ve ranking do tenant inteiro. Colaborador ve somente clientes com
atendimento proprio elegivel e nao edita nada.

**A lista mostra telefone completo?** Nao. Lista mostra telefone mascarado. Telefone cru e nota
interna continuam fora do ranking.

**Vai mandar WhatsApp ou criar automacao?** Nao. WhatsApp, automacao, broadcast, exportacao e score
comercial ficam fora de escopo.

**Quando liga em producao?** O codigo nasce com `RANKING_SEM_RETORNO_ENABLED` default OFF. Rollout
global so depois de CI verde, reviews QA/security e smoke humano aprovados.

## Escopo

- Ranking read-only baseado na entidade `clientes` canonica da ADR 0040.
- Elegibilidade por atendimento ativo (`deleted_at IS NULL`), nao cancelado e passado.
- Agenda: data de referencia `COALESCE(fim_at, inicio_at) <= now()`.
- Manual: data de referencia `data` e nunca futura.
- Owner ve tenant inteiro, sempre escopado por `slot + tenant_id` da sessao.
- Colaborador ve somente atendimento proprio, com `colaborador_id` vindo da sessao.
- Lista com PII minima: `cliente_id`, nome exibivel, `telefone_masked`, ultimo atendimento
  elegivel, dias sem retorno e ultimo profissional autorizado.
- Paginacao inicial por offset com `limit <= 50` e `offset <= 100`.
- Indice novo ou validacao de indice existente comprovando caminho escopado e barato.
- Flag `RANKING_SEM_RETORNO_ENABLED` default OFF; OFF responde 404 `feature_off`.

## Fora de Escopo

- Editar app, db ou frontend nesta branch documental.
- WhatsApp manual, automacao, lembrete, broadcast, campanha, fila de disparo ou integracao externa.
- Exportacao CSV/Excel/API.
- Backfill, seed ou lazy upsert dentro de qualquer GET de ranking.
- Ranking por valor financeiro, pacote, probabilidade de compra, IA ou prioridade comercial.
- Mostrar telefone cru, telefone canonico, `nota_interna`, observacoes ou payload de agenda na
  lista.

## Contratos

### API

- `GET /portal/clientes/sem-retorno` retorna ranking do dono.
- `GET /portal/colaborador/clientes/sem-retorno` retorna ranking do colaborador.
- Query aceita `limit` e `offset`; `offset > 100` retorna 400 ou equivalente fail-closed.
- Body e query nao aceitam `slot`, `tenant_id`, `colaborador_id`, telefone cru, telefone canonico,
  `nota_interna`, `export`, `whatsapp` ou `automation`.
- Resposta e read-only e nao inclui links/acoes de envio.

### Dados

- A identidade vem de `clientes.tenant_id + clientes.telefone_canonico`.
- A ligacao com historico usa `atendimentos.cliente_telefone_canonico`.
- Toda query inclui `clientes.slot = $slot`, `clientes.tenant_id = $tenantId` e o mesmo escopo nos
  atendimentos agregados.
- O ultimo retorno por cliente e `MAX(data_referencia)` entre atendimentos elegiveis.
- O ranking nao cria linha em `clientes`, nao atualiza `cliente_telefone_canonico` e nao chama seed.
- Atendimentos soft-deletados ficam fora do ranking por default.

### RBAC

- Dono: carteira inteira do tenant; autorizacao por `withTenant`.
- Colaborador: read-only; autorizacao por `withColaborador` e `EXISTS`/join em atendimento proprio.
- Nenhum parametro do cliente escolhe tenant, slot ou colaborador.
- Falha de escopo retorna 404 generico, sem diferenciar inexistente de proibido.

### LGPD e Logs

- Lista expoe telefone mascarado apenas.
- `nota_interna` e owner-only no perfil CRM; ranking nunca seleciona nem serializa esse campo.
- Logs nao gravam telefone cru/canonico, nome de cliente, nota, observacao ou payload GCal.
- Metricas permitidas: contagem, duracao, limit/offset validos e reason codes sem PII.

## Riscos

| Risco | Mitigacao |
|---|---|
| ranking virar canal de disparo | fora de escopo explicito para WhatsApp, automacao e exportacao |
| vazamento cross-tenant | `slot + tenant_id` obrigatorios em clientes e atendimentos |
| colaborador enxergar carteira alheia | SQL com `colaborador_id` da sessao e teste anti-IDOR |
| exposicao de telefone/nota | lista com `telefone_masked`; sem `nota_interna` no SELECT/DTO/log |
| DoS por historico grande | `limit <= 50`, `offset <= 100`, indice verificavel e flag OFF |
| mutacao escondida em GET | teste garantindo ausencia de seed/backfill/upsert no endpoint |

## Definition of Done

- [ ] ADR 0041 revisado antes de qualquer codigo.
- [ ] Backend implementa flag default OFF e 404 `feature_off` sem consulta pesada.
- [ ] Query usa somente parametros; nenhum SQL concatena input do usuario.
- [ ] Owner recebe ranking somente do proprio `slot + tenant_id`.
- [ ] Colaborador recebe somente clientes com atendimento elegivel proprio.
- [ ] Teste cobre atendimento deletado, cancelado, futuro, agenda sem `fim_at` e manual por `data`.
- [ ] Teste cobre lista sem telefone cru/canonico e sem `nota_interna`.
- [ ] Teste cobre GET sem seed/backfill/upsert.
- [ ] Teste cobre `offset=100` aceito e `offset=101` rejeitado.
- [ ] Indice/predicado de elegibilidade comprovado por teste SQL ou `EXPLAIN`.
- [ ] Reviews QA e security aprovam RBAC, LGPD, performance e flag.
- [ ] CI completo verde antes de merge.
- [ ] Smoke humano no portal antes de ligar globalmente.
- [ ] Rollout global somente apos CI, reviews e smoke, medindo env real do container.

## Rollback

1. Manter `RANKING_SEM_RETORNO_ENABLED=false` ou remover a env para voltar ao default OFF.
2. Se ja houver codigo, reverter a PR sem executar hard delete.
3. Migrations aditivas de indice podem permanecer inertes em rollback quente.
4. Validar que CRM Clientes base segue funcionando e que nenhuma rota de ranking responde ON.
