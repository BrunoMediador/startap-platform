# ADR 0041 - CRM Ranking Sem Retorno

**Status:** Proposto
**Data:** 2026-08-21
**Missao:** [035 - CRM Ranking Sem Retorno](../missoes/035-crm-ranking-sem-retorno.md)
**Decisores:** Bruno, arquiteto, security
**Relacionado:** [0040 - CRM Clientes: base canonica por tenant e telefone](0040-crm-clientes-base-canonica.md)

## Contexto

A base canonica de CRM Clientes (ADR 0040) cria uma entidade `clientes` por empresa, usando
`tenant_id + telefone_canonico` como identidade funcional. A proxima fatia e ajudar o dono a
priorizar clientes que ja tiveram atendimento concluido e ainda nao voltaram.

O ranking nao pode virar canal de disparo, exportacao ou automacao. A regra de negocio existente
tambem separa atendimento futuro de atendimento realizado: relatorios de faturamento ja contam como
realizado apenas linhas ativas, nao canceladas e passadas, usando `fim_at <= now()` para agenda e
tratando `origem='manual'` como atendimento manual realizado.

## Decisao

Criar uma leitura paginada "sem retorno" sobre a entidade `clientes` canonica e sobre
`atendimentos.cliente_telefone_canonico`, atras de `RANKING_SEM_RETORNO_ENABLED` default OFF.

Uma pessoa entra no ranking apenas se existir pelo menos um atendimento elegivel no mesmo
`tenant_id`, `slot` e `telefone_canonico`. Atendimento elegivel e:

- ativo: `deleted_at IS NULL`;
- nao cancelado: `status <> 'cancelado'`;
- de cliente identificavel: `cliente_telefone_canonico IS NOT NULL`;
- nunca futuro;
- quando `origem='agenda'`, a data de referencia e `COALESCE(fim_at, inicio_at)` e precisa ser
  menor ou igual a `now()`;
- quando `origem='manual'`, a data de referencia e `data` e precisa ser menor ou igual ao dia
  corrente no fuso do produto.

O ranking e ordenado pelo atendimento elegivel mais antigo entre os ultimos atendimentos por
cliente, com desempate estavel por `cliente_id`. A consulta nao cria cliente, nao atualiza snapshot
e nao executa seed ou backfill.

## RBAC e Isolamento

O dono ve o ranking do tenant inteiro. Todas as rotas de dono usam `withTenant`; `slot`,
`tenant_id` e `userId` vem da sessao/banco, nunca de body, query ou params.

O colaborador ve somente clientes com atendimento elegivel proprio. A rota usa `withColaborador`;
`colaborador_id` vem exclusivamente da sessao revalidada. A autorizacao deve ser parte do SQL por
`EXISTS` ou join escopado em `atendimentos`, nunca filtro apenas no frontend.

Todo acesso por `cliente_id` ou cursor futuro deve casar `clientes.id + slot + tenant_id`.
No colaborador, tambem precisa casar atendimento proprio. Falha de escopo retorna 404 generico.

## PII e Dados Expostos

A lista do ranking retorna PII minima:

- `cliente_id`;
- nome exibivel se ja existir na base canonica;
- `telefone_masked`, nunca telefone cru;
- data do ultimo atendimento elegivel;
- dias sem retorno;
- ultimo profissional visivel dentro do escopo autorizado, quando houver.

A lista nao retorna `telefone_raw`, `telefone_canonico`, `nota_interna`, observacoes, historico,
titulo de evento GCal, payload de origem, `gcal_event_id`, dados de agenda externa ou campos de
contato ativo. `nota_interna` continua owner-only apenas no perfil CRM autorizado da ADR 0040; ela
nao participa do ranking, de logs, metricas ou ordenacao.

Logs do ranking gravam somente dados tecnicos escopados (`slot`, `tenant_id` quando ja permitido
em log interno, contagens, duracao e reason code). Telefone cru, telefone canonico, nome de cliente
e nota interna ficam proibidos em log e erro.

## API Surface

Superficie inicial:

- `GET /portal/clientes/sem-retorno`: ranking read-only do dono.
- `GET /portal/colaborador/clientes/sem-retorno`: ranking read-only do colaborador.

Parametros aceitos inicialmente:

- `limit`: inteiro `1..50`;
- `offset`: inteiro `0..100`;
- filtros opcionais somente se estiverem escopados e parametrizados.

Qualquer payload/query com `slot`, `tenant_id`, `colaborador_id`, telefone cru, telefone canonico,
`nota_interna`, exportacao, disparo, WhatsApp ou automacao deve ser rejeitado ou ignorado de forma
explicita no contrato de teste.

## Indices

A implementacao deve incluir indice verificavel antes de rollout ON. O caminho minimo esperado e
indexar os atendimentos elegiveis por tenant/slot/cliente/data de referencia, separado quando
necessario para agenda e manual:

- owner agenda: `(tenant_id, slot, cliente_telefone_canonico, COALESCE(fim_at, inicio_at) DESC, id DESC)`
  com predicado parcial para `deleted_at IS NULL`, `status <> 'cancelado'`, `origem='agenda'` e
  `cliente_telefone_canonico IS NOT NULL`;
- owner manual: `(tenant_id, slot, cliente_telefone_canonico, data DESC, id DESC)` com o mesmo
  predicado parcial e `origem='manual'`;
- colaborador: variantes equivalentes incluindo `colaborador_id`.

O aceite exige `EXPLAIN` ou teste SQL que prove uso do indice/predicado escopado na consulta de
ranking. Query que varre atendimento sem `tenant_id + slot` e bug de seguranca e desempenho.

## Rollout

`RANKING_SEM_RETORNO_ENABLED` nasce default OFF no codigo. O rollout global so pode ocorrer depois
de CI verde, reviews de QA/security e smoke humano aprovados. A feature OFF responde 404
`feature_off`, sem executar consulta pesada.

## Fora de Escopo

- WhatsApp manual, envio ativo, automacao, lembrete, broadcast ou integracao de disparo.
- Exportacao CSV/Excel/API externa.
- Backfill, seed em GET ou migration que percorra toda a base para materializar ranking.
- Ranking por valor gasto, recencia de conversa WhatsApp, IA, score comercial ou anotacao manual.
- Expor telefone cru ou `nota_interna` na lista.

## Consequencias

Beneficios:

- O dono ganha priorizacao operacional sem contato automatizado.
- Colaborador recebe uma fila propria sem enxergar carteira de outros profissionais.
- O calculo reaproveita a identidade canonica de clientes e nao reabre deduplicacao por nome.

Trade-offs:

- Offset limitado a 100 e simples para a primeira fatia; pagina profunda fica fora do MVP.
- Sem seed/backfill em GET, clientes sem linha canonica ainda nao aparecem ate a populacao normal
  da base ou um backfill posterior, batelado e aprovado.
- O indice adicional aumenta custo de escrita em `atendimentos`, mas evita DoS por ranking em
  tenant com historico grande.

## Criterios de Aceite de Seguranca

- Flag default OFF retorna 404 `feature_off` antes de tocar DB caro.
- Dono so recebe linhas do proprio `tenant_id + slot`.
- Colaborador so recebe cliente com atendimento elegivel proprio.
- IDOR por `cliente_id` ou parametro de pagina nao enumera outro tenant/slot/profissional.
- Lista nao contem telefone cru, telefone canonico, nota, payload GCal ou observacao.
- Logs e erros nao contem PII.
- GET de ranking nao chama seed, backfill, upsert ou mutation.
- Query e parametrizada, paginada, `offset <= 100` e escopada antes de filtros textuais.
- Indice/predicado de elegibilidade e verificavel por teste ou `EXPLAIN`.
