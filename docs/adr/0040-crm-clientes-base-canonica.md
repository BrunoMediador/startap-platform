# ADR 0040 - CRM Clientes: base canonica por tenant e telefone

**Status:** Proposto
**Data:** 2026-08-21
**Missao:** [034 - CRM Clientes: base canonica](../missoes/034-crm-clientes-base.md)
**Decisores:** Bruno, arquiteto, security

## Contexto

O produto ja grava nome e contato do cliente final como snapshot em `atendimentos`, mas esse formato nao oferece uma identidade estavel para perfil, historico por pessoa, aniversario, cidade ou nota interna. ADR 0026 registrou essa limitacao como trade-off aceito da v1 de faturamento: `cliente_nome` e `cliente_contato` eram texto livre e a referencia a uma tabela de clientes ficaria para o futuro.

A Missao 034 transforma esse futuro em uma base pequena e segura. O objetivo e criar uma entidade pesquisavel por empresa, sem alterar snapshots historicos de `atendimentos` e sem abrir caminho para vazamento entre tenants, donos e colaboradores.

## Decisao

Criar uma entidade `clientes` por `tenant_id + telefone_canonico`, escopada tambem por `slot`, aditiva e atras de `CRM_CLIENTES_ENABLED` default OFF no codigo.

O identificador funcional do cliente final e o telefone canonico calculado no backend com a regra existente de identidade (`canonicalE164`). O nome nunca deduplica cliente, e nao existe cadastro global entre empresas.

Campos da entidade:

- `id` como chave tecnica.
- `tenant_id` e `slot` obrigatorios em todas as linhas.
- `telefone_canonico` obrigatorio.
- `nome_preferido` opcional.
- `aniversario_mm_dd` opcional, sem ano.
- `cidade` opcional.
- `nota_interna` opcional, exclusiva do dono.
- `created_by_user_id`, `updated_by_user_id`, `created_at`, `updated_at`.
- `deleted_at`, `deleted_reason`, `deleted_by` para soft delete.

## RBAC

O dono acessa a carteira inteira do proprio tenant e pode editar os campos de perfil opcionais. Toda rota do dono usa `withTenant`; `slot`, `tenant_id` e `userId` vem da sessao ou do banco, nunca do body, query ou params.

O colaborador acessa apenas clientes que tenham pelo menos um atendimento proprio no mesmo `slot` e `tenant_id`. A autorizacao do colaborador usa `withColaborador`; `colaborador_id` vem exclusivamente da sessao revalidada no banco. O colaborador nao edita perfil e nao recebe `nota_interna`.

Endpoints que recebem `:id` devem buscar por `id + slot + tenant_id`; endpoints de colaborador tambem exigem `EXISTS` em `atendimentos` para o `colaborador_id` da sessao. Falha de escopo retorna 404 generico, nao 403 enumeravel.

## PII e Logs

Telefone completo e PII. Lista deve retornar o minimo necessario; perfil autorizado pode exibir telefone completo quando fizer parte da tarefa do usuario. Logs nunca gravam telefone cru nem `nota_interna`; quando precisar correlacionar, usar helper mascarado/hash ja existente (`phoneHint`/tag de log).

`nota_interna` e dado sensivel de negocio do cliente. Ela nao entra em resposta de colaborador, metrica, log, erro, exportacao implicita, contexto de IA ou qualquer fluxo fora do perfil autorizado.

## Criacao e Populacao

A primeira escrita acontece por lazy upsert idempotente a partir de atendimentos novos ou alterados que contenham contato valido. Esse caminho nunca altera `atendimentos.cliente_nome` ou `atendimentos.cliente_contato`; os snapshots permanecem historicos.

Backfill dos atendimentos existentes fica como etapa posterior, batelada, idempotente e medida. Ele deve escopar por `tenant_id + slot`, ignorar contatos que nao canonicalizam e nunca fundir por nome. O backfill nao roda como migration pesada que faca lock amplo.

## Retencao e Exclusao

Exclusao de cliente no MVP e soft delete: preencher `deleted_at`, `deleted_reason` e `deleted_by`. Listas e buscas filtram linhas deletadas por default. Atendimentos historicos permanecem intactos porque sao snapshot financeiro/operacional.

Hard delete e politica formal de expurgo ficam fora deste ADR e exigem decisao propria de LGPD/retencao antes de implementacao.

## Indices

Indices minimos esperados:

- `UNIQUE (tenant_id, telefone_canonico)` para identidade funcional.
- `(slot, tenant_id, deleted_at, updated_at DESC, id DESC)` para listagem paginada.
- Indice de busca por nome preferido escopada por `slot + tenant_id`.
- Indice de telefone canonico escopado por `slot + tenant_id` para busca exata/prefixada.
- Em `atendimentos`, o caminho de historico por perfil deve usar predicados `slot + tenant_id + cliente_contato` ou uma chave derivada segura, sempre parametrizada.

Qualquer `ILIKE` deve vir depois do escopo `slot + tenant_id`, com limite e paginacao. Query sem tenant e bug de seguranca.

## API Surface

Superficie inicial:

- `GET /portal/clientes`: lista do dono, paginada, busca por nome/telefone.
- `GET /portal/clientes/:id`: perfil do dono com historico e campos opcionais.
- `PATCH /portal/clientes/:id`: edicao owner-only dos campos opcionais.
- `GET /portal/colaborador/clientes`: lista read-only do colaborador.
- `GET /portal/colaborador/clientes/:id`: perfil read-only do colaborador, sem nota interna.

Payloads rejeitam `slot`, `tenant_id`, `colaborador_id`, `created_by_user_id`, `updated_by_user_id`, `deleted_*` e qualquer campo fora da allowlist.

## Rollout

O codigo nasce com `CRM_CLIENTES_ENABLED` default OFF. Bruno deu GO de produto para ligar globalmente depois de CI verde, reviews de QA/security e smoke humano aprovados. Ate esses gates passarem, a feature permanece dormente em producao.

## Consequencias

Beneficios:

- Identidade de cliente final deixa de depender de nome livre.
- Historico por pessoa fica possivel sem reescrever snapshots.
- Dono e colaborador recebem visoes diferentes por desenho, nao por filtro de UI.
- Base fica pronta para evolucoes futuras sem ampliar a superficie inicial.

Trade-offs:

- `canonicalE164` une numeros brasileiros com e sem nono digito. Isso e desejado para identidade, mas exige testes com dados reais conhecidos e sem alterar numeros usados para envio/pareamento.
- Backfill posterior evita lock amplo agora, mas a carteira antiga aparece completa apenas depois da rotina batelada.
- Soft delete preserva historico e reduz risco operacional, mas nao substitui uma politica de expurgo formal.

## Criterios de Aceite de Seguranca

- Teste anti-IDOR: dono nao acessa cliente de outro `slot/tenant_id`.
- Teste anti-IDOR: colaborador nao acessa cliente sem atendimento proprio.
- Teste de resposta: colaborador nunca recebe `nota_interna`.
- Teste de payload: body/query com `slot`, `tenant_id` ou `colaborador_id` e rejeitado ou ignorado de forma explicita.
- Teste de busca: toda query e parametrizada, paginada e escopada por `slot + tenant_id`.
- Teste de PII: logs nao contem telefone cru nem nota interna.
- Teste de flag: default OFF retorna rota dormente; ON so apos gates de rollout.
