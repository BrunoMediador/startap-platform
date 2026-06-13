-- Migration 045: tenant_id UUID (Fase 1, ADR 0018) — coluna aditiva nullable + backfill.
--
-- Pilar 1 dos "3 pilares de escala" (decisão Bruno, 2026-06-12).
-- Desenho: docs/adr/0018-tenant-id-identidade-por-cliente.md (Passo 1 do plano).
--
-- O QUE FAZ (somente Fase 1 — NADA de dual-write, cutover, FK, NOT NULL ou RLS):
--   1. flow_clones ganha tenant_id UUID DEFAULT gen_random_uuid() — flow_clones é a
--      ÂNCORA canônica do tenant (Bruno confirmou: ancorar no flow_clones existente,
--      NÃO criar tabela `clients` nova). Cada clone existente recebe um UUID estável.
--   2. As tabelas-satélite que chaveiam por `slot` ganham tenant_id UUID NULL
--      (sem FK ainda, sem NOT NULL ainda — postura aditiva idêntica à migration 044).
--   3. Backfill idempotente: resolve slot -> flow_clones.tenant_id em cada satélite.
--   4. Índice por tenant_id em cada tabela (prepara junção/relatório da fase seguinte).
--
-- DIVERGÊNCIA ADR x SCHEMA REAL (confiamos no schema real — ADR §"Se o ADR divergir
-- da realidade do schema, confie no schema real e reporte"):
--   O ADR 0018 (Passo 1) lista `leads`, `bot_pausa` e `flow_pause_keywords` como
--   satélites. No schema REAL desta base eles NÃO são slot-anchored:
--     * `leads` NÃO existe; a tabela real é `leads_vendas_barbearia` e ela NÃO tem
--       coluna `slot` (id, nome, telefone, mensagem_inicial, origem, criado_em) —
--       não há como resolver slot -> tenant_id. FORA desta migration.
--     * `bot_pausa` é tabela LEGADA chaveada por `numero_cliente` (telefone) + flag
--       `pausado`; NÃO tem coluna `slot`. FORA.
--     * `flow_pauses` / `flow_pause_keywords` são chaveadas por `flow_id` (id de
--       workflow WAHA, ex. '0ni38aSspWwhooHd'), NÃO por `slot`. FORA.
--   Mapear essas tabelas para tenant_id é um passo separado (exige resolver
--   flow_id/telefone -> slot primeiro) e fica fora do escopo da Fase 1.
--
--   Satélites EFETIVAMENTE incluídas (todas têm coluna `slot` que casa com
--   flow_clones.slot): bot_config, bot_prompt, bot_media, bot_courses,
--   client_billing, billing_charges, model_usage.
--
-- SLOTS DE PLATAFORMA (esperado ficar tenant_id NULL após o backfill):
--   bot_config/model_usage têm os slots `startap` (Lola), `teste_barbearia`
--   (matriz), `teste_vendas`, `teste_vendas_barbearia` que NÃO têm linha em
--   flow_clones. O backfill (WHERE s.slot = fc.slot) os deixa NULL de propósito —
--   tenant_id de plataforma é decisão de seed à parte (ADR Passo 0). Esperado.
--
-- ISOLAMENTO: a tenant key em uso continua sendo `slot` (ADR 0007/0016). tenant_id
--   é 100% camada de banco; NINGUÉM lê por ele ainda. Não toca WAHA. Não muda nenhum
--   caminho de leitura/escrita em uso. Não piora a postura de RLS atual.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, UPDATE com
--   guard `AND s.tenant_id IS NULL`. Roda 2x sem erro; 2ª é no-op.
--
-- Rollback (REVERSÍVEL — NUNCA dropar na mesma release que cria; release separada):
--   BEGIN;
--     ALTER TABLE flow_clones    DROP COLUMN IF EXISTS tenant_id;
--     ALTER TABLE bot_config     DROP COLUMN IF EXISTS tenant_id;
--     ALTER TABLE bot_prompt     DROP COLUMN IF EXISTS tenant_id;
--     ALTER TABLE bot_media      DROP COLUMN IF EXISTS tenant_id;
--     ALTER TABLE bot_courses    DROP COLUMN IF EXISTS tenant_id;
--     ALTER TABLE client_billing DROP COLUMN IF EXISTS tenant_id;
--     ALTER TABLE billing_charges DROP COLUMN IF EXISTS tenant_id;
--     ALTER TABLE model_usage    DROP COLUMN IF EXISTS tenant_id;
--   COMMIT;
--   (Nenhum dado de cliente é perdido: tudo aqui é aditivo e nullable.)

BEGIN;

-- gen_random_uuid() vem da extensão pgcrypto (disponível na imagem PG 16).
-- Idempotente. Confirmar disponibilidade na imagem antes de aplicar em prod (devops).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. Âncora: flow_clones.tenant_id — fonte da verdade do tenant.
--    DEFAULT gen_random_uuid() carimba cada clone EXISTENTE com um UUID estável.
-- ============================================================
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS idx_flow_clones_tenant ON flow_clones (tenant_id);

-- ============================================================
-- 2. Satélites: tenant_id UUID NULL (sem FK, sem NOT NULL — Fase 1).
-- ============================================================
ALTER TABLE bot_config      ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;
ALTER TABLE bot_prompt      ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;
ALTER TABLE bot_media       ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;
ALTER TABLE bot_courses     ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;
ALTER TABLE client_billing  ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;
ALTER TABLE model_usage     ADD COLUMN IF NOT EXISTS tenant_id UUID NULL;

-- ============================================================
-- 3. Backfill: slot -> flow_clones.tenant_id. Idempotente (guard tenant_id IS NULL).
--    Slots sem linha em flow_clones (plataforma) ficam NULL — esperado.
-- ============================================================
UPDATE bot_config s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE bot_prompt s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE bot_media s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE bot_courses s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE client_billing s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE billing_charges s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE model_usage s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

-- ============================================================
-- 4. Índices por tenant_id nas satélites (prepara junção/relatório).
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_bot_config_tenant      ON bot_config (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bot_prompt_tenant      ON bot_prompt (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bot_media_tenant       ON bot_media (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bot_courses_tenant     ON bot_courses (tenant_id);
CREATE INDEX IF NOT EXISTS idx_client_billing_tenant  ON client_billing (tenant_id);
CREATE INDEX IF NOT EXISTS idx_billing_charges_tenant ON billing_charges (tenant_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_tenant     ON model_usage (tenant_id);

COMMIT;
