-- Migration 059: billing derivado da agenda — split previsão×faturado + sticky de edição
-- (ADR 0027). ADITIVA sobre `atendimentos` (058). Pré-requisito da Fase B2 (gancho
-- criar-no-agendamento + sync no cancelar/remarcar), que vem DEPOIS deste schema.
--
-- DECISÃO (Bruno, settled): billing derivado da agenda, automático, sem confirmação;
-- separar PREVISÃO (futuro) de FATURADO (passado); editar valor é STICKY (não volta pro
-- preço do catálogo); remover = some (soft-delete, sem trilha/estorno); comissão só
-- sobre faturado.
--
-- COLUNAS NOVAS em `atendimentos`:
--   * origem        — 'agenda' (derivado de evento do GCal) | 'manual' (walk-in registrado
--                     direto no painel). Default 'manual' = compatível com as linhas de hoje
--                     (POST /portal/atendimentos do MVP 058 cria walk-in).
--   * dirty_fields  — lista (JSONB array) das COLUNAS pinadas por edição manual do dono.
--                     É o CORAÇÃO do "sticky": upsertAtendimentoFromEvent NÃO sobrescreve
--                     nenhuma coluna presente aqui. Default '[]' = nada pinado.
--   * inicio_at/fim_at — instantes do evento (TIMESTAMPTZ). Split previsão×faturado é
--                     STATELESS: previsão = fim_at > now(); faturado = fim_at <= now()
--                     (ou origem='manual'). Sem job mudando status — o relógio decide.
--                     NULL = walk-in sem janela de tempo (cai em faturado por origem).
--   * deleted_at    — soft-delete ("some de tudo"). NULL = ativo. Preenchido = invisível
--                     em TODO relatório/listagem. Sem estorno, sem trilha visível.
--
-- ÍNDICE PARCIAL ux_atend_event_ativo: garante NO MÁXIMO 1 atendimento ATIVO por evento
--   do GCal por slot (idempotência do upsert por evento). Só conta linhas com
--   gcal_event_id NÃO nulo E deleted_at NULL — walk-ins (gcal_event_id NULL) e linhas
--   soft-deletadas ficam de fora (podem coexistir N). É o alvo do ON CONFLICT do upsert.
--   Escopado por (slot, gcal_event_id): o mesmo event_id NUNCA colide cross-slot.
--
-- ADITIVA: só ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. SEM backfill (os
--   defaults cobrem as linhas existentes: origem='manual', dirty_fields='[]',
--   inicio/fim/deleted = NULL — exatamente o estado correto pra um walk-in já gravado).
--   SEM tocar linha existente. Nenhum pagante afetado. Tudo atrás da flag ATEND_FROM_AGENDA
--   (default OFF) + ATENDIMENTOS_ENABLED.
--
-- Idempotente: re-rodar é no-op (IF NOT EXISTS em coluna e índice). NÃO destrutiva:
--   nenhum DROP/DELETE/TRUNCATE sobre dado existente.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação
--    explícita do Bruno) ──────────────────────────────────────────────────────────────
--   BEGIN;
--     DROP INDEX IF EXISTS ux_atend_event_ativo;
--     ALTER TABLE atendimentos DROP COLUMN IF EXISTS deleted_at;
--     ALTER TABLE atendimentos DROP COLUMN IF EXISTS fim_at;
--     ALTER TABLE atendimentos DROP COLUMN IF EXISTS inicio_at;
--     ALTER TABLE atendimentos DROP COLUMN IF EXISTS dirty_fields;
--     ALTER TABLE atendimentos DROP COLUMN IF EXISTS origem;
--   COMMIT;
--   → as colunas/índice somem; o MVP 058 (walk-in manual) volta a operar igual. Flag OFF
--     = produção idêntica; nenhum pagante afetado.
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS origem       VARCHAR(12) NOT NULL DEFAULT 'manual';

ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS dirty_fields JSONB       NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS inicio_at    TIMESTAMPTZ;

ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS fim_at       TIMESTAMPTZ;

ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;

COMMENT ON COLUMN atendimentos.origem IS
  'agenda = derivado de evento do GCal (Fase B2); manual = walk-in registrado no painel. ADR 0027.';
COMMENT ON COLUMN atendimentos.dirty_fields IS
  'JSONB array das colunas pinadas por edição manual do dono. upsertAtendimentoFromEvent NÃO sobrescreve estas (sticky). ADR 0027.';
COMMENT ON COLUMN atendimentos.fim_at IS
  'Fim do evento. Split STATELESS: previsão = fim_at > now(); faturado = fim_at <= now() ou origem=manual. ADR 0027.';
COMMENT ON COLUMN atendimentos.deleted_at IS
  'Soft-delete: preenchido = some de TODO relatório/listagem. Sem estorno/trilha. ADR 0027.';

-- 1 atendimento ATIVO por evento por slot (idempotência do upsert por evento).
-- Parcial: walk-ins (gcal_event_id NULL) e linhas soft-deletadas (deleted_at NOT NULL)
-- ficam de fora — podem coexistir N. Alvo do ON CONFLICT do upsertAtendimentoFromEvent.
CREATE UNIQUE INDEX IF NOT EXISTS ux_atend_event_ativo
  ON atendimentos (slot, gcal_event_id)
  WHERE gcal_event_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;
