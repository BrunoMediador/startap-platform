# Missao 034 - CRM Clientes: base canonica

**DRI:** arquiteto + backend-senior
**Apetite:** medio
**Status:** pronta para implementacao apos ADR 0040
**ADR:** [0040 - CRM Clientes: base canonica por tenant e telefone](../adr/0040-crm-clientes-base-canonica.md)

## PR-FAQ

### Press release

A Startap passa a reunir, em cada empresa, os dados ja produzidos por atendimentos em um perfil de
cliente pesquisavel. O dono ve a carteira inteira; cada colaborador ve somente pessoas que ja
atendeu. O perfil mostra historico e permite completar, opcionalmente, aniversario, cidade e nota
interna.

### FAQ

**Por que criar uma entidade própria?** Hoje nome e contato são snapshots em `atendimentos`; sem
uma identidade canônica não há histórico confiável, aniversário ou cálculo posterior de retorno.

**Como a pessoa é identificada?** Por `tenant_id` + telefone canônico. Nunca por nome e nunca
globalmente entre empresas.

**Quem pode ver e editar?** Dono vê todos e edita o perfil. Colaborador vê somente clientes para
os quais possui atendimento próprio e não edita dados de perfil nesta primeira fase.

**Quando liga em producao?** O codigo começa com `CRM_CLIENTES_ENABLED` default OFF. Bruno deu GO
para ligar globalmente depois de CI verde, reviews QA/security e smoke humano aprovados.

## Escopo

- Tabela aditiva `clientes` com `id`, `tenant_id`, `slot`, telefone canonico, nome preferido,
  aniversario opcional sem ano, cidade opcional, nota interna opcional, autoria, timestamps e
  soft delete.
- Lazy-upsert idempotente a partir de atendimentos novos ou alterados.
- Backfill posterior, batelado e medido a partir de atendimentos existentes, sem apagar snapshots
  historicos e sem fundir por nome.
- Lista paginada e pesquisa por nome/telefone no portal do dono.
- Perfil com atendimentos historicos e profissional; campos opcionais editaveis pelo dono.
- Visão de colaborador limitada aos seus próprios atendimentos, sem nota e sem edição.
- Nova flag `CRM_CLIENTES_ENABLED` default OFF no codigo; rollout global autorizado somente apos
  CI, reviews e smoke.

## Fora de escopo

- Mesclagem manual, importação/exportação, deduplicação por nome e cadastro global entre tenants.
- Alterar `atendimentos.cliente_nome`/`cliente_contato` retroativamente ou apagar contatos.
- Hard delete ou politica formal de expurgo.

## Contratos e segurança

- Toda query usa `tenant_id` e `slot`; identidade de colaborador vem exclusivamente da sessão.
- Listagem de colaborador usa `EXISTS`/join por `colaborador_id` do atendimento e nunca aceita
  colaborador no body/query como critério de autorização.
- Telefone completo é PII: só aparece quando necessário no perfil autorizado; logs usam hash e
  nunca gravam nota ou telefone cru.
- `nota_interna` nunca aparece para colaborador e nunca entra em log, erro ou métrica.
- Aniversário, cidade e nota são estritamente opcionais e só são escritos por ação manual do dono.
- Pesquisa deve ser parametrizada, paginada e com limite; não usar `ILIKE` sem escopo tenant.
- Payloads rejeitam ou ignoram explicitamente `slot`, `tenant_id`, `colaborador_id`, autoria e
  campos de soft delete.

## Riscos

| Risco | Mitigação |
|---|---|
| duplicidade por fontes atuais diferentes | chave por tenant + telefone canônico; snapshots permanecem imutáveis |
| vazamento de carteira entre profissionais | RBAC por sessão e testes anti-IDOR owner/colaborador |
| exposição desnecessária de PII | mínimo de campos na lista, detalhe autorizado e logs sanitizados |
| backfill pesado | lazy-upsert primeiro; backfill posterior batelado e medido, nunca lock amplo |
| enumeração por `cliente_id` | buscar sempre por `id + slot + tenant_id`; colaborador exige `EXISTS` próprio |

## Definition of Done

- [ ] ADR 0040 revisado antes de migration por tocar entidade nova e historico.
- [ ] QA e security aprovam RBAC, LGPD, pesquisa e backfill.
- [ ] Dono lista/pesquisa/perfil/edita campos opcionais dentro do tenant.
- [ ] Colaborador só lista clientes com atendimento próprio, sem edição nem nota interna.
- [ ] Nenhum fluxo de contato ativo entra no diff desta missão.
- [ ] CI, E2E de UX e smoke humano passam antes de qualquer flag ON.
- [ ] Rollout global só ocorre depois dos gates acima, usando `CRM_CLIENTES_ENABLED`.
