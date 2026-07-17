-- Migration 074: atendimentos.{deleted_reason,deleted_by} — trilha durável do soft-delete (SCRUM-90).
--
-- MOTIVO (fast-follow do SCRUM-89 / ADR 0031; condição de review pra LIGAR GCAL_ATEND_SYNC em prod):
--   O reconciler gcal-atend-sync (apps/worker/src/jobs/gcal-atend-sync.ts) soft-deleta linhas de
--   `atendimentos` cujo evento SUMIU da agenda — INCLUSIVE linha já PAGA (decisão do dono: a agenda é
--   a fonte da verdade; a salvaguarda "nunca deletar pago" foi derrubada). O único registro da remoção
--   hoje é um log.warn (efêmero). O security P2 pediu TRILHA DURÁVEL no banco: quem apagou e por quê.
--
-- FIX: 2 colunas TEXT NULL na própria linha soft-deletada. O soft-delete carimba as duas NO MESMO
--   UPDATE do deleted_at (atomicidade real — sem trigger, sem tabela de auditoria extra):
--     deleted_reason  = motivo  ('gcal_sync_absent' | 'portal_cancel' | 'portal_delete' | NULL)
--     deleted_by      = ator    ('gcal-atend-sync'  | 'portal'        | NULL)
--   NULL = deleção legada / caminho ainda não instrumentado (nenhuma coluna NOT NULL — retrocompatível).
--
-- POR QUE COLUNAS NA PRÓPRIA LINHA (e não tabela de auditoria):
--   A linha soft-deletada continua existindo (deleted_at IS NOT NULL) e guarda o gcal_event_id CRU +
--   valor/forma/data — a investigação já mora nela. reason/by completam o "quem/por quê" no mesmo lugar,
--   1 UPDATE, zero JOIN. TEXT NULL (sem default) = ADD COLUMN metadata-only no PG (sem rewrite da tabela).
--
-- ISOLAMENTO / multi-tenancy: aditivo puro — não piora a dívida P0 (segue por coluna `slot`). As colunas
--   não guardam PII (motivo/ator são rótulos fixos do sistema, nunca telefone/nome).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS (re-rodar = no-op). NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE;
--   nenhuma coluna removida; sem DEFAULT/backfill (linhas antigas ficam NULL = "origem desconhecida").
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9: nunca dropar coluna na mesma
--    release que a adiciona; só com aprovação explícita do Bruno) ─────────────────────────────────
--   BEGIN;
--     ALTER TABLE atendimentos DROP COLUMN IF EXISTS deleted_reason;
--     ALTER TABLE atendimentos DROP COLUMN IF EXISTS deleted_by;
--   COMMIT;
--   → as colunas somem; o soft-delete volta a gravar só deleted_at (o código escreve NULL quando não
--     há audit, e o SET das colunas ausentes viraria erro — por isso o rollback exige remover TAMBÉM
--     o SET no código, ou seja: reverter o PR do SCRUM-90 ANTES de dropar as colunas).
-- ───────────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Motivo da deleção. NULL = deleção legada / caminho não instrumentado. Sem default (metadata-only).
ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT NULL;

-- Ator que deletou (subsistema/rota). NULL = legado. Sem default (metadata-only).
ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS deleted_by TEXT NULL;

COMMENT ON COLUMN atendimentos.deleted_reason IS
  'SCRUM-90: motivo do soft-delete, carimbado no mesmo UPDATE do deleted_at. Ex.: gcal_sync_absent (reconciler), portal_cancel (cancelamento no portal), portal_delete (DELETE do operador). NULL = deleção legada. Sem PII.';
COMMENT ON COLUMN atendimentos.deleted_by IS
  'SCRUM-90: ator que soft-deletou (subsistema/rota). Ex.: gcal-atend-sync, portal. NULL = legado. Sem PII.';

COMMIT;
