-- Migration 071: TTL opcional em flow_pauses + frases de pausa default do piloto Meduzza.
--
-- ENTREGA 1 (SCRUM-59, "mesmo número IA + atendente"): a pausa por RESPOSTA HUMANA à mão
-- (source='human_reply') precisa VOLTAR sozinha depois de um tempo. Adiciona a coluna
-- `expires_at` (NULL = pausa permanente, comportamento atual de TODAS as pausas existentes:
-- keyword/escalated_human/portal/antibot). A leitura é LAZY (isFlowPaused ignora expiradas);
-- não precisa de cron pra limpar.
--
-- ENTREGA 2: seed das frases de pausa/retomada default do clone-piloto Meduzza em
-- flow_pause_keywords (o dono edita depois pela nova API do portal).
--
-- ADITIVA e REVERSÍVEL: ADD COLUMN IF NOT EXISTS (carimba NULL em toda linha existente =>
-- byte-idêntico), seed com ON CONFLICT DO NOTHING. Sem DROP/DELETE/TRUNCATE.
-- Rollback (se necessário, em release SEPARADA — regra de ouro 9): ALTER TABLE flow_pauses
-- DROP COLUMN IF EXISTS expires_at; e DELETE das 2 linhas seed do slot Meduzza.

BEGIN;

-- 1. TTL opcional. NULL = permanente (default de toda pausa que já existe).
ALTER TABLE flow_pauses ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL;

-- Índice parcial só das pausas COM validade (as human_reply) — barato e útil pra
-- um cleanup oportunista futuro; não afeta as pausas permanentes (expires_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_flow_pauses_expires_at
  ON flow_pauses (expires_at)
  WHERE expires_at IS NOT NULL;

-- 2. Seed das frases default do piloto Meduzza (clone_meduzza_barbearia_q23psc).
--    keyword_norm = normalização do app (lowercase + NFD sem acento + sem espaço) —
--    mesma de normalizeManualPauseCommand (apps/api/src/lib/manual-pause.ts) e da 009.
--    ON CONFLICT DO NOTHING: idempotente e não sobrescreve edição futura do dono.
WITH seed(command, keyword, keyword_norm) AS (
  VALUES
    ('pause',  'atendente aqui!!',    'atendenteaqui!!'),
    ('resume', 'assistente voltar!!', 'assistentevoltar!!')
)
INSERT INTO flow_pause_keywords (flow_id, command, keyword, keyword_norm, enabled, updated_at)
SELECT 'clone_meduzza_barbearia_q23psc', seed.command, seed.keyword, seed.keyword_norm, TRUE, NOW()
FROM seed
ON CONFLICT (flow_id, command, keyword_norm) DO NOTHING;

COMMIT;
