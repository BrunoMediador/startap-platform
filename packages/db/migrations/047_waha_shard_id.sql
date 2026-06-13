-- Migration 047: waha_shard_id — registro de shard de WAHA por clone (ADR 0020, Passo 1).
--
-- Pilar 3 dos "3 pilares de escala" (decisão Bruno, 2026-06-12).
-- Desenho: docs/adr/0020-shard-waha-por-tenant.md (Passo 1 — "Registro de shard por sessão").
--
-- O QUE FAZ (somente PREP — NADA de mover sessão, subir container ou trocar URL):
--   1. flow_clones ganha waha_shard_id INT NOT NULL DEFAULT 0. O shard 0 é o
--      container WAHA atual (`automacoes-waha-1`) — onde TODAS as sessões já vivem
--      hoje. DEFAULT 0 carimba cada clone EXISTENTE no shard atual.
--   2. Índice parcial por shard != 0 (prepara consultas futuras "quem está fora do
--      shard 0"; hoje o índice fica vazio, pois ninguém saiu do shard 0).
--
-- POR QUE SEGURO (safe-by-construction):
--   * Aditivo + DEFAULT 0 = todo mundo no shard atual = comportamento IDÊNTICO ao de
--     hoje. Nenhuma sessão é movida. Ninguém é roteado para outro lugar.
--   * O roteamento por shard fica atrás da flag `WAHA_SHARDING` (default OFF) no
--     código; com a flag OFF a coluna nem é lida — usa-se a WAHA_URL única de hoje.
--   * Mesmo com a flag ON, o mapa de shards só tem o shard 0 = URL atual → idêntico
--     até que um shard 1 exista (devops sobe container + adiciona no mapa, fora desta
--     migration).
--
-- ESCOPO: SÓ flow_clones (a âncora slot->sessão; ADR 0020 §"flow_clones.waha_sessao
--   é o lugar do waha_shard_id"). Não toca bot_config nem satélites — o shard é
--   propriedade da sessão, e a sessão vive no clone. Não toca WAHA. Não muda nenhum
--   caminho de leitura/escrita em uso.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS. Roda 2x sem
--   erro; 2ª é no-op. Backfill é o próprio DEFAULT 0 (rows existentes recebem 0 no
--   ADD COLUMN). NÃO precisa de UPDATE explícito — DEFAULT já carimba o histórico.
--
-- Rollback (REVERSÍVEL — NUNCA dropar na mesma release que cria; release separada):
--   BEGIN;
--     DROP INDEX IF EXISTS idx_flow_clones_waha_shard;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS waha_shard_id;
--   COMMIT;
--   (Nenhum dado de cliente é perdido: tudo aqui é aditivo e tem default.)
--
-- Validação pós-aplicação:
--   SELECT waha_sessao, waha_shard_id FROM flow_clones;  -- todos waha_shard_id = 0

BEGIN;

-- ============================================================
-- 1. flow_clones.waha_shard_id — shard do container WAHA da sessão.
--    DEFAULT 0 = shard atual (`automacoes-waha-1`). Carimba todo clone existente.
-- ============================================================
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS waha_shard_id integer NOT NULL DEFAULT 0;

-- ============================================================
-- 2. Índice parcial: só clones FORA do shard 0 (clientes novos em shards novos).
--    Hoje fica vazio (todos no shard 0). Prepara o roteamento/relatório por shard
--    sem custo de índice sobre a maioria que segue no shard 0.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_flow_clones_waha_shard
  ON flow_clones (waha_shard_id) WHERE waha_shard_id <> 0;

COMMIT;
