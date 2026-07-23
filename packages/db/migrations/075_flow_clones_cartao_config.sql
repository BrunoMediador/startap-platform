-- Migration 075: flow_clones.{cartao_mode,cartao_config} — fundação do cartão de confirmação
-- injetável em RUNTIME (SCRUM-92 increment 2 / ADR 0032). ADITIVA e DORMENTE nesta release.
--
-- MOTIVO (SCRUM-92 inc.2, "injeção do cartão no runtime"):
--   Hoje o CARTÃO DE CONFIRMAÇÃO do caminho INDIVIDUAL vive BAKED no bot_prompt (texto
--   persistido, com 💈/✂️ da barbearia). O increment 2 vai permitir montar o cartão EM
--   RUNTIME (como o estabelecimento já faz, via buildCartaoEstabelecimentoBlock) — sem
--   reescrever o bot_prompt de cada clone. Pra isso, cada clone precisa declarar DE ONDE vem
--   o cartão dele: `baked` (do bot_prompt, comportamento de HOJE) ou `runtime` (montado por
--   código a partir de cartao_config). Esta migration só CRIA o estado durável; a injeção em
--   runtime (o código que LÊ estas colunas) NÃO existe ainda e NÃO é habilitada aqui.
--
-- POR QUE COLUNAS NOVAS EM flow_clones:
--   "de onde vem o cartão deste clone" e "os campos/ícones do cartão" são propriedades
--   DURÁVEIS do clone, não inferíveis do dado. Moram em flow_clones (âncora do tenant),
--   1 linha por clone. O DEFAULT 'baked' carimba TODA linha existente — Cirilo/Samuel e
--   todo clone atual seguem BYTE-A-BYTE (cartão do bot_prompt, nada injetado). cartao_config
--   é NULL por padrão = "use os defaults por área" (nenhum override).
--
-- POR QUE cartao_mode É text+CHECK (e não boolean):
--   Domínio fechado de 2 valores hoje ('baked'|'runtime'), mas nomeável e extensível (ex.
--   um 'hybrid' futuro) sem trocar o tipo. O CHECK dá validação forte no schema (sem ORM na
--   casa). cartao_config é JSONB nullable — flexível pro shape do cartão evoluir sem migration
--   (o app valida a forma, padrão das migrations 051/068).
--
-- BACKFILL: NENHUM. O DEFAULT 'baked' cobre todo mundo no próprio ALTER (backfill implícito).
--   Todo clone nasce/permanece 'baked' = comportamento atual. Não setamos dado de nenhum
--   cliente aqui (ligar 'runtime' num clone é passo futuro, gated, decisão de produto).
--
-- ISOLAMENTO / multi-tenancy: aditivo puro — não piora a dívida P0 (segue por coluna `slot`).
--   Colunas moram em flow_clones (que já carrega tenant_id/slot); tenant_id não é necessário
--   (a âncora é a própria linha do clone).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS (re-rodar = no-op; o CHECK inline não re-aplica quando
--   a coluna já existe). NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida
--   na mesma release. Registro em schema_migrations é feito PELO RUNNER (scripts/migrate.sh)
--   por nome de arquivo — este SQL NÃO insere em schema_migrations (padrão das migrations
--   068/070/072; o gate do deploy.sh exige COUNT(*.sql) == COUNT(schema_migrations)).
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9: nunca dropar coluna na
--    mesma release que a adiciona; só com aprovação explícita do Bruno) ────────────────────────
--   BEGIN;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS cartao_config;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS cartao_mode;
--   COMMIT;
--   → as colunas somem; como NENHUM código as lê ainda (injeção em runtime não existe nesta
--     release), a reversão é 100% inócua — comportamento de hoje inalterado nos dois sentidos.
-- ───────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Fonte do cartão de confirmação deste clone. DEFAULT 'baked' carimba toda linha existente no
-- próprio ALTER (backfill implícito) — cartão segue vindo do bot_prompt como hoje. CHECK fecha
-- o domínio ('baked'|'runtime') no schema (validação forte, sem ORM).
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS cartao_mode TEXT NOT NULL DEFAULT 'baked'
  CHECK (cartao_mode IN ('baked', 'runtime'));

-- Config do cartão montado em runtime (campos/ícones/labels). NULL = usar os defaults por área
-- (nenhum override). Shape validado no app, não no banco (padrão migrations 051/068).
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS cartao_config JSONB;

COMMENT ON COLUMN flow_clones.cartao_mode IS
  'Fonte do cartão de confirmação: baked = vem do bot_prompt (comportamento atual); runtime = montado por código a partir de cartao_config (SCRUM-92 inc.2/ADR 0032). Default baked.';
COMMENT ON COLUMN flow_clones.cartao_config IS
  'Config JSONB do cartão quando cartao_mode=runtime (campos/ícones/labels). NULL = defaults por área. Validado no app, não no banco. Dormente até o increment 2.';

COMMIT;
