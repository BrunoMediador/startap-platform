-- SCRUM-45 — Role Postgres de runtime com MENOR PRIVILÉGIO para o app (startap_app).
--
-- ⚠️⚠️ ESTE ARQUIVO NÃO É UMA MIGRATION AUTO-APLICADA. ⚠️⚠️
--   Ele vive em scripts/ DE PROPÓSITO (NÃO em packages/db/migrations/) para que
--   scripts/migrate.sh (deploy automático na main) NUNCA o rode sozinho. Motivos:
--     1) Precisa de uma SENHA passada em runtime (-v app_pw='...') — o migrate.sh não
--        injeta a variável, então o CREATE ROLE quebraria o deploy (ou criaria role sem
--        senha usável).
--     2) CREATE ROLE + ALTER DEFAULT PRIVILEGES são operações privilegiadas que devem
--        rodar UMA vez, numa janela controlada, como SUPERUSER — não a cada deploy.
--   Rodar SÓ manualmente na janela de cutover (runbook: docs/empresa/scrum45-cutover-runbook.md).
--
-- O QUE ESTE SCRIPT FAZ (e NÃO faz):
--   Cria o role de RUNTIME `startap_app` com o MÍNIMO pra o app funcionar: LOGIN + CRUD
--   (SELECT/INSERT/UPDATE/DELETE) em todas as tabelas de `public`, USAGE/SELECT nas
--   sequences, USAGE no schema, CONNECT no banco. SEM SUPERUSER, SEM CREATEDB, SEM
--   CREATEROLE, SEM BYPASSRLS, SEM REPLICATION, SEM nenhum DDL.
--   NÃO rebaixa o `startap_user` (superuser que carrega DDL/migrations) — ele CONTINUA
--   dono de tabelas e rodando o migrate.sh. Só o APP passa a conectar como startap_app
--   (cutover = trocar PG_USER nos 4 serviços; NÃO faz parte deste SQL).
--
-- OWNERSHIP DIVIDIDO (recon SCRUM-45): as tabelas de `public` têm DOIS donos —
--   `startap_user` (~28) e `startap_cluster_admin` (~31). O GRANT ON ALL TABLES cobre
--   as tabelas que JÁ existem; mas objetos FUTUROS só herdam grant via ALTER DEFAULT
--   PRIVILEGES, e este é POR-DONO. Por isso configuramos DEFAULT PRIVILEGES para OS DOIS
--   donos — senão a PRÓXIMA migration cria uma tabela INVISÍVEL ao app (permission denied),
--   dependendo de qual role a criou.
--
-- PRIVILÉGIOS QUE O APP USA (auditados por grep no código de runtime — SCRUM-45):
--   • SELECT/INSERT/UPDATE/DELETE em tabelas — CRUD normal (coberto).
--   • Sequences (SERIAL/BIGSERIAL) em INSERT — precisa USAGE/SELECT nas sequences (coberto).
--   • Advisory locks: pg_advisory_xact_lock / pg_try_advisory_xact_lock (billing-charges.ts,
--     trial-ledger.ts) — funções BUILT-IN, EXECUTE por PUBLIC. NÃO precisa grant.
--   • pg_notify('flow_execution_logs', ...) (flow-execution-log.ts, best-effort/.catch) —
--     built-in PUBLIC. NÃO precisa grant.
--   • gen_random_uuid() como DEFAULT de coluna (flow_clones.tenant_id, migração 045) —
--     built-in/pgcrypto, EXECUTE por PUBLIC. NÃO precisa grant.
--   • SELECT ... FOR UPDATE (27 pontos) — row lock, coberto pelo DML. NÃO precisa grant.
--   NÃO encontrado no runtime: TRUNCATE, CREATE TEMP TABLE, COPY FROM/TO, LISTEN, SET ROLE,
--   DDL (CREATE/ALTER/DROP), GRANT/REVOKE, funções custom, views/matviews/triggers.
--   → Nenhum grant EXTRA além de CRUD + sequences + USAGE/CONNECT é necessário.
--   ⚠️ CAVEAT: GRANT ON ALL TABLES inclui VIEWS mas NÃO materialized views (nenhuma existe
--     hoje). Se um dia surgir uma MATVIEW/foreign table lida pelo app, dar SELECT explícito.
--
-- COMO RODAR (janela de cutover, como superuser — startap_user OU postgres):
--   APP_PW="$(openssl rand -base64 24)"   # gere e GUARDE fora do banco (cofre/.env)
--   docker exec -i automacoes-postgres-1 \
--     psql -U startap_user -d startap_database -v ON_ERROR_STOP=1 \
--          -v app_pw="$APP_PW" -f - < scripts/scrum45-create-app-role.sql
--   (opcional) passar -v pgdb=<outro_banco> se o banco não for startap_database.
--
-- IDEMPOTENTE: re-rodar é seguro. CREATE ROLE é guardado por checagem em pg_roles; ALTER
--   ROLE (re)aplica atributos+senha; GRANT/ALTER DEFAULT PRIVILEGES são idempotentes.
--   NÃO destrutivo: nenhum DROP/DELETE/TRUNCATE/REVOKE.
--
-- ── ROLLBACK (SÓ na janela, com aprovação do Bruno; primeiro voltar PG_USER=startap_user
--    nos 4 serviços + recreate, DEPOIS remover o role) ────────────────────────────────────
--   -- 1) desfaz os DEFAULT PRIVILEGES (tem que casar EXATO o que foi concedido, por dono):
--   ALTER DEFAULT PRIVILEGES FOR ROLE startap_user          IN SCHEMA public
--     REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLES    FROM startap_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE startap_cluster_admin IN SCHEMA public
--     REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLES    FROM startap_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE startap_user          IN SCHEMA public
--     REVOKE USAGE,SELECT               ON SEQUENCES  FROM startap_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE startap_cluster_admin IN SCHEMA public
--     REVOKE USAGE,SELECT               ON SEQUENCES  FROM startap_app;
--   -- 2) tira os grants explícitos e o role (DROP OWNED limpa dependências de grant):
--   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM startap_app;
--   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM startap_app;
--   REVOKE ALL ON SCHEMA public FROM startap_app;
--   REVOKE CONNECT ON DATABASE startap_database FROM startap_app;
--   DROP OWNED BY startap_app;   -- limpa grants residuais (o role não é dono de nada)
--   DROP ROLE IF EXISTS startap_app;
--   -- OBS: o app já estará de volta em startap_user; rollback do role é opcional/higiene.
-- ────────────────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

-- Banco alvo do CONNECT: usa -v pgdb=... se passado; senão default startap_database (prod).
\if :{?pgdb}
\else
  \set pgdb startap_database
\endif

\echo '==> SCRUM-45: criando/atualizando role de runtime startap_app (menor privilégio)'

-- ── 1) ROLE (idempotente) ────────────────────────────────────────────────────────────────
-- CREATE ROLE não tem IF NOT EXISTS; guardamos por checagem em pg_roles.
-- A senha (:'app_pw') fica em statement de TOP-LEVEL (fora de bloco dollar-quoted) pra o psql
-- interpolar a variável corretamente. ::text garante 'true'/'false' pro \if.
SELECT (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'startap_app'))::text AS need_create \gset

\if :need_create
  \echo '    -> role ausente: CREATE ROLE startap_app'
  CREATE ROLE startap_app WITH
    LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOBYPASSRLS
    NOREPLICATION;
\else
  \echo '    -> role já existe: pulando CREATE (senha/atributos reaplicados abaixo)'
\endif

-- (Re)aplica atributos + senha SEMPRE — idempotente e garante o estado mesmo se o role
-- pré-existia com config diferente. A senha vem de -v app_pw (nunca hardcoded no repo).
ALTER ROLE startap_app WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOREPLICATION
  PASSWORD :'app_pw';

-- ── 2) CONECTAR NO BANCO + USAR O SCHEMA ─────────────────────────────────────────────────
GRANT CONNECT ON DATABASE :"pgdb" TO startap_app;
GRANT USAGE ON SCHEMA public TO startap_app;

-- ── 3) GRANTS nas tabelas/sequences que JÁ existem ───────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO startap_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO startap_app;

-- ── 4) DEFAULT PRIVILEGES pros DOIS donos (objetos FUTUROS herdam grant automaticamente) ──
-- Sem isto, a próxima migration cria tabela INVISÍVEL ao app dependendo de quem a criou.
ALTER DEFAULT PRIVILEGES FOR ROLE startap_user          IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO startap_app;
ALTER DEFAULT PRIVILEGES FOR ROLE startap_cluster_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO startap_app;
ALTER DEFAULT PRIVILEGES FOR ROLE startap_user          IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO startap_app;
ALTER DEFAULT PRIVILEGES FOR ROLE startap_cluster_admin IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO startap_app;

-- ── 5) VERIFICAÇÃO (read-only; imprime o estado pro operador conferir) ────────────────────
\echo '==> verificação: atributos do role (esperado: todos os "rol*" perigosos = f)'
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin
  FROM pg_roles WHERE rolname = 'startap_app';

\echo '==> verificação: nº de tabelas de public em que startap_app tem cada privilégio'
\echo '    (deve bater com o total de tabelas base de public — nenhuma tabela órfã)'
SELECT privilege_type, count(*) AS n_tabelas
  FROM information_schema.role_table_grants
  WHERE grantee = 'startap_app' AND table_schema = 'public'
  GROUP BY privilege_type ORDER BY privilege_type;

\echo '==> verificação: DEFAULT PRIVILEGES configurados (esperado: 4 linhas — 2 donos x tabelas/sequences)'
SELECT pg_get_userbyid(d.defaclrole) AS dono, d.defaclobjtype AS objtype, d.defaclacl
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  WHERE n.nspname = 'public'
    AND array_to_string(d.defaclacl, ',') LIKE '%startap_app=%';

\echo '==> SCRUM-45: role startap_app pronto. NENHUM serviço aponta pra ele ainda —'
\echo '    o cutover (trocar PG_USER + recreate) é passo SEPARADO do runbook.'
