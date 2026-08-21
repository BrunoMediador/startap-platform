# ADR 0042 - CRM Aniversariantes Read-only

**Status:** Proposto
**Data:** 2026-08-21
**Missao:** [036 - CRM Aniversariantes Read-only](../missoes/036-crm-aniversariantes-readonly.md)
**Decisores:** Bruno, arquiteto, security
**Relacionado:** [0040 - CRM Clientes: base canonica por tenant e telefone](0040-crm-clientes-base-canonica.md), [0041 - CRM Ranking Sem Retorno](0041-crm-ranking-sem-retorno.md)

## Fontes

- Memoria de produto atual: `.claude/memory/estado/produto.md`, secao "CRM Clientes - ranking Sem Retorno LIVE".
- Regras de negocio atuais: `.claude/memory/regras-negocio.md`, especialmente LGPD, feature flag e proibicao de contato direto com cliente.
- Schema CRM atual: `packages/db/migrations/084_crm_clientes.sql:3`, `:10`, `:22`.
- Rotas CRM atuais: `apps/portal-api/src/routes/portal-clientes.ts:60`, `:77`, `:88`, `:100`, `:140`, `:243`.
- Flags CRM atuais: `apps/portal-api/src/config.schema.ts:255`, `:266`.
- Padrao de lista com telefone mascarado: `packages/db/src/queries/clientes.ts:216`, `:229`.

## Contexto

O CRM canonico ja possui `clientes.aniversario_mmdd` opcional, armazenado sem ano e editavel no
perfil do dono. A proxima fatia deve transformar esse dado em uma lista read-only de aniversariantes,
sem criar canal de contato, sem automacao, sem exportacao e sem popular dados historicos.

Aniversario e PII. A lista deve ajudar a operacao humana a lembrar datas, mas nao pode virar fonte
de enriquecimento, disparo de WhatsApp ou enumeracao de carteira entre tenants/profissionais.

## Decisao

Criar uma leitura "Aniversariantes" sobre a entidade `clientes`, atras de
`CRM_ANIVERSARIANTES_ENABLED` default OFF e dependente de `CRM_CLIENTES_ENABLED`.

Nao criar nova entidade de pessoa e nao armazenar data de nascimento completa com ano. O modelo
canonico da fatia e `aniversario_mmdd` (`MM-DD`), manual, opcional e sem ano. Cliente sem
`aniversario_mmdd` fica fora da lista. Esta fatia nao faz backfill, seed, lazy upsert em GET nem
inferencias a partir de conversas, agenda ou historico.

## RBAC e Isolamento

Dono acessa a carteira CRM do tenant no escopo autorizado pelo portal. Na implementacao atual, as
rotas de dono derivam `slot` da sessao via `withTenant` e `tenant_id/timezone` do banco; a query de
aniversariantes deve seguir esse mesmo padrao e nunca aceitar `slot`, `tenant_id` ou `userId` do
cliente HTTP.

Colaborador acessa somente leitura e somente clientes que tenham pelo menos um atendimento proprio
no mesmo `slot` e `tenant_id`. O `colaborador_id` vem de `withColaborador` e da sessao revalidada,
nunca de query/body. O filtro de colaborador deve estar no SQL por `EXISTS` ou join escopado em
`atendimentos`, nao no frontend.

Qualquer acesso por `cliente_id` futuro deve casar `clientes.id + slot + tenant_id`; para
colaborador tambem deve provar atendimento proprio. Falha de escopo retorna 404 generico.

## Timezone e Janelas

Todas as comparacoes usam o timezone do slot/tenant obtido no servidor (`getScopeBySlot`), nao um
timezone enviado pelo navegador. A data "hoje" e sempre a data local nesse timezone.

A API inicial suporta duas janelas:

- `modo=proximos`: lista aniversarios nos proximos `dias` dias, incluindo hoje; `dias` default 30,
  maximo 31.
- `modo=mes`: lista aniversarios de um mes calendario `mes=1..12`, independente do ano corrente.

Como o dado nao tem ano, a ordenacao de `proximos` e por dias ate a proxima ocorrencia local,
depois nome e `id`. A ordenacao de `mes` e por dia do mes, depois nome e `id`. `02-29` so aparece
quando a janela contem um 29 de fevereiro real; nao deve ser normalizado para 28/02 ou 01/03.

O schema atual valida formato `MM-DD`, mas permite combinacoes impossiveis como `02-31`. A leitura
deve tratar datas impossiveis como dado invalido: nao quebrar a resposta, nao tentar corrigir e nao
incluir a linha ate que o perfil seja corrigido em fluxo proprio.

## API Surface

Superficie inicial:

- `GET /portal/clientes/aniversariantes`: lista read-only do dono.
- `GET /portal/colaborador/clientes/aniversariantes`: lista read-only do colaborador.

Parametros aceitos, com schema `.strict()`:

- `modo`: `proximos` ou `mes`, default `proximos`;
- `dias`: inteiro `1..31`, aceito apenas em `modo=proximos`;
- `mes`: inteiro `1..12`, obrigatorio em `modo=mes`;
- `limit`: inteiro `1..50`;
- `offset`: inteiro `0..100`.

Nao ha body. Query com `slot`, `tenant_id`, `colaborador_id`, telefone, `nota_interna`, `export`,
`whatsapp`, `automation` ou parametro desconhecido deve falhar fechado com 400.

Resposta da lista:

- `id`;
- `nome` se ja existir na base canonica;
- `telefone_masked`;
- `aniversario_mmdd`;
- `proxima_ocorrencia_local_date` quando `modo=proximos`;
- `dias_ate_aniversario` quando `modo=proximos`;
- `total`, `limit`, `offset`.

A lista nao retorna telefone cru, telefone canonico, `telefone_raw`, `cidade`, `nota_interna`,
historico, observacoes, payload GCal, dados de WhatsApp, links de disparo ou acoes mutantes.

## PII e Logs

Logs e erros nao gravam telefone cru/canonico, nome de cliente, aniversario, nota ou payload de
origem. Metricas permitidas: rota, status, duracao, `limit`, `offset`, modo, contagens e reason code
sem PII.

`nota_interna` permanece owner-only no perfil CRM da ADR 0040 e nao participa do SELECT, DTO,
ordenacao, filtro, log ou metrica de aniversariantes.

## Migracao e Indices

A fatia nao precisa de coluna nova porque `clientes.aniversario_mmdd` ja existe. A migration deve ser
aditiva e limitada a indice verificavel para a leitura:

- `ix_clientes_aniversariantes_slot_tenant_mmdd` em `(slot, tenant_id, aniversario_mmdd, id)` com
  predicado `aniversario_mmdd IS NOT NULL`.

Se `deleted_at` existir no momento da implementacao, listas e indice parcial tambem devem filtrar
`deleted_at IS NULL`. Nao adicionar constraint mais restritiva de calendario nesta fatia sem antes
auditar dados existentes, porque a constraint atual aceita formato, nao validade de dia por mes.

## Rollout

`CRM_ANIVERSARIANTES_ENABLED` nasce default OFF no codigo. OFF responde 404 `feature_off` antes de
tocar DB caro e antes de calcular janela. Rollout global so depois de CI verde, reviews QA/security e
smoke humano aprovados.

## Fora de Escopo

- WhatsApp manual, parabens automatico, lembrete, campanha, broadcast ou qualquer envio.
- Automacao, fila, webhook, IA, recomendacao de mensagem ou ranking comercial.
- Exportacao CSV/Excel/API externa.
- Backfill, seed em GET, enriquecimento por conversa, importacao ou inferencia de aniversario.
- Edicao de data por colaborador.
- Armazenar ano de nascimento ou idade.

## Consequencias

Beneficios:

- Reaproveita a base canonica sem ampliar identidade de pessoa.
- Mantem a minimizacao LGPD: mes/dia opcional, telefone mascarado e sem ano.
- Da valor operacional ao dono/colaborador sem criar contato automatizado.

Trade-offs:

- Sem backfill, a lista nasce incompleta ate o dono preencher aniversarios manualmente.
- Sem ano, nao ha idade nem analise demografica; isso e intencional por minimizacao.
- A validacao atual de `MM-DD` exige cuidado para datas impossiveis nao quebrarem a consulta.

## Criterios de Aceite de Seguranca

- Flag default OFF retorna 404 `feature_off` antes de consultar `clientes`.
- Dono so recebe linhas do proprio escopo `slot + tenant_id` derivado do servidor.
- Colaborador so recebe cliente com atendimento proprio no mesmo `slot + tenant_id`.
- Query/body com `slot`, `tenant_id`, `colaborador_id`, telefone, `nota_interna` ou parametro extra
  falha fechado.
- Lista nao contem telefone cru/canonico, `telefone_raw`, `cidade`, `nota_interna`, historico ou
  acao de envio.
- Logs e erros nao contem PII.
- GET nao chama seed, backfill, lazy upsert ou qualquer mutation.
- `limit <= 50`, `offset <= 100`, `dias <= 31` e query parametrizada.
- Data impossivel em `aniversario_mmdd` nao causa 500 e nao entra na lista.
- Teste de timezone cobre borda de meia-noite e virada de ano.
- Indice de aniversariantes e comprovado por teste SQL ou `EXPLAIN`.
