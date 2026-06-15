-- Migration 052: tipo de conta (individual vs estabelecimento) em flow_clones.
--
-- ADR 0023, Fase A. Introduz a FRONTEIRA de modelo "conta multi-colaborador"
-- sobre a âncora flow_clones, de forma 100% ADITIVA, NULLABLE onde precisa, e
-- REVERSÍVEL. Nenhum pagante é afetado: o default 'individual' carimba toda
-- linha existente (Cirilo R$85, Samuel R$50) sem tocar dado nenhum, e o gating
-- por product_type no app garante que o caminho individual nunca alcança código novo.
--
-- DUAS colunas, ambas aditivas:
--   1) product_type VARCHAR(16) NOT NULL DEFAULT 'individual'
--        valores: 'individual' | 'estabelecimento'
--        A TAXONOMIA é validada por Zod NO APP (padrão da migration 051 de `area`),
--        NÃO por CHECK no banco — assim o conjunto de tipos evolui sem nova migration.
--        Backfill IMPLÍCITO: o DEFAULT preenche toda linha existente como 'individual'.
--        NÃO há UPDATE de backfill — o default já cobre (não sobrescreve nada).
--   2) seat_cap SMALLINT (NULLABLE)
--        teto de colaboradores da faixa contratada (ex.: 3/5/10). NULL = individual
--        (sem teto, sem colaborador). Enforcement do teto vive no app (CHECK não
--        conhece a contagem de colaboradores ativos — ADR 0023 §consequências).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS em ambas. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhum NOT NULL sem default;
--   nenhum FK obrigatório novo. Atende ao critério de aceite 2 do ADR 0023.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9, nunca dropar
--    coluna na mesma release que a adiciona; só com aprovação explícita do Bruno) ──
--   BEGIN;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS seat_cap;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS product_type;
--   COMMIT;
--   → colunas somem; o app volta a tratar tudo como individual (caminho atual).
--     Nenhum pagante depende dessas colunas (todos são individual via default).
-- ───────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Tipo de conta. DEFAULT 'individual' carimba toda linha existente no próprio
--    ALTER (backfill implícito) — sem UPDATE adicional, sem sobrescrever nada.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS product_type VARCHAR(16) NOT NULL DEFAULT 'individual';

COMMENT ON COLUMN flow_clones.product_type IS
  'Tipo de conta: individual | estabelecimento. Taxonomia validada por Zod no app (ADR 0023), NAO por CHECK aqui. DEFAULT individual carimba todo clone existente (Cirilo/Samuel intactos).';

-- 2) Teto de colaboradores da faixa (NULL = individual, sem teto/colaborador).
--    Enforcement do (N+1)-esimo colaborador e no runtime (CHECK nao conta linhas).
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS seat_cap SMALLINT;

COMMENT ON COLUMN flow_clones.seat_cap IS
  'Teto de colaboradores da faixa contratada (ex.: 3/5/10). NULL para individual (sem teto). Enforcement no app, nao no banco (ADR 0023).';

COMMIT;
