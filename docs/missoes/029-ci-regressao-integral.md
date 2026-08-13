# Missão 029 — Cinto de segurança de regressão integral no CI

**DRI:** backend-senior
**Agentes envolvidos:** backend-senior (implementação), qa-tester (review e confirmação no GitHub Actions)
**Apetite:** pequeno (até 1 dia, uma PR de CI/testes)
**Status:** implementada localmente; aguardando review e PR
**ADR:** dispensado — mudança menor que 300 linhas, sem decisão de arquitetura ou runtime
**PR-FAQ:** dispensado — gate interno, sem capability de produto

---

## Contexto e causa raiz

O CI executava apenas `npx vitest run`. A raiz excluía explicitamente `painel-admin/test/**`
porque esses arquivos usam `node:test`, mas nenhuma etapa substituta os executava. Resultado:
28 arquivos e 326 testes do gestão ficavam invisíveis mesmo com CI verde.

O serviço Postgres 16 já existia para testes de integração, mas o CI nunca aplicava a cadeia de
migrations. A história versionada começa em 002 sobre duas tabelas legadas preexistentes;
o baseline 001 mínimo precisa materializá-las antes de validar 002→080 em banco vazio.

## Objetivo

Fazer toda PR falhar se o painel legado quebrar ou se a cadeia completa de migrations deixar de
ser aplicável em um Postgres 16 efêmero, sem duplicar a suíte Vitest nem aumentar a infraestrutura.

## Escopo

- Executar `painel-admin/test/*.test.js` uma única vez com o runner nativo do Node.
- Aplicar o baseline legado 001 e todas as migrations versionadas, em ordem lexical, no Postgres
  16 descartável já fornecido pelo job.
- Recusar `PG_TEST_URL` remota e banco não vazio antes de qualquer escrita.
- Manter o Vitest responsável apenas por `packages/*`, `apps/*`, `scripts/*.test.ts` e docs de teste.
- Atualizar comentários e comandos de regressão para refletir os gates reais.

## Definition of Done (DoD)

- [x] `npm run test:panel` executa os 28 arquivos/326 testes do painel e falha com qualquer teste vermelho.
- [x] `npm run test:migrations` exige Postgres 16 local, banco vazio e `PG_TEST_URL` explícita.
- [x] O gate aplica baseline 001 + migrations 002→080 e confere 79/79 registros.
- [x] Falha informa o nome exato da migration; banco reutilizado falha antes de aplicar SQL.
- [x] `npm test` continua executado uma única vez; painel não entra no Vitest.
- [x] Worktrees, `node_modules` e artefatos `dist` continuam fora da descoberta do Vitest.
- [x] Sem Playwright, Docker Compose, env nova, migration de produção ou mudança no app.
- [x] Build de todos os workspaces e suíte completa verdes localmente.
- [ ] GitHub Actions verde confirmado pelo qa-tester após publicação da PR.

## Ordem exata do CI

1. `npm ci --no-audit --no-fund`
2. `npm run build --workspaces --if-present`
3. `PG_TEST_URL=... npm run test:migrations`
4. `npm run test:panel`
5. `PG_TEST_URL=... npm test`

## Rollback

Reverter a PR. O banco do CI é descartável e o gate não altera migrations nem schema de produção;
não há rollback de dados, env ou aplicação.

## Fora de escopo

- Playwright, smoke humano no navegador, Docker Compose ou e2e de serviços.
- Testar o transporte `docker exec` do runner de produção `scripts/migrate.sh`.
- Alterar app, migrations já aplicadas, deploy, flags ou produção.

## Riscos

- **Tempo:** +~3 s locais (migrations + painel), pequeno diante do build do portal.
- **Drift do baseline:** uma migration futura pode depender de outro objeto legado. Mitigação: falha
  diagnóstica no primeiro arquivo afetado; baseline só muda quando a dependência for comprovada.
- **Falsa segurança do runner:** o gate valida SQL e ordem, não Docker/stdin de produção. O runner
  continua protegido pelo pós-check de `schema_migrations` no deploy.
