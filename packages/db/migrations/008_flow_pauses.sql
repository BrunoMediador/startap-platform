-- Migration 008: pausa independente por fluxo.
-- Idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS flow_pauses (
  flow_id     VARCHAR(100) NOT NULL,
  flow_name   VARCHAR(150),
  telefone    VARCHAR(32) NOT NULL,
  session     VARCHAR(100),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  source      VARCHAR(40) DEFAULT 'manual',
  reason      TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_id, telefone)
);

CREATE INDEX IF NOT EXISTS idx_flow_pauses_telefone
  ON flow_pauses (telefone);
CREATE INDEX IF NOT EXISTS idx_flow_pauses_active
  ON flow_pauses (active, flow_id);

DO $$
BEGIN
  IF to_regclass('public.pausa_cirilo') IS NOT NULL THEN
    INSERT INTO flow_pauses (flow_id, flow_name, telefone, active, source, reason, updated_at)
    SELECT '0ni38aSspWwhooHd', 'teste_barbearia', numero, TRUE, 'legacy', 'Migrado de pausa_cirilo', NOW()
    FROM pausa_cirilo
    ON CONFLICT (flow_id, telefone) DO UPDATE SET
      active = TRUE,
      source = 'legacy',
      reason = COALESCE(flow_pauses.reason, EXCLUDED.reason),
      updated_at = NOW();
  END IF;

  IF to_regclass('public.pause_ricardo') IS NOT NULL THEN
    INSERT INTO flow_pauses (flow_id, flow_name, telefone, active, source, reason, updated_at)
    SELECT 'dlpKXM3gvX2joC1b', 'teste_vendas', numero, TRUE, 'legacy', 'Migrado de pause_ricardo', NOW()
    FROM pause_ricardo
    ON CONFLICT (flow_id, telefone) DO UPDATE SET
      active = TRUE,
      source = 'legacy',
      reason = COALESCE(flow_pauses.reason, EXCLUDED.reason),
      updated_at = NOW();
  END IF;

  IF to_regclass('public.pause_startap') IS NOT NULL THEN
    INSERT INTO flow_pauses (flow_id, flow_name, telefone, active, source, reason, updated_at)
    SELECT 'uUS3Ux1cU2DquKxo', 'STARTTAP_AI', numero, TRUE, 'legacy', 'Migrado de pause_startap', NOW()
    FROM pause_startap
    ON CONFLICT (flow_id, telefone) DO UPDATE SET
      active = TRUE,
      source = 'legacy',
      reason = COALESCE(flow_pauses.reason, EXCLUDED.reason),
      updated_at = NOW();
  END IF;
END $$;

UPDATE project_databases
SET metadata = jsonb_set(
    metadata,
    '{tables}',
    (
      SELECT jsonb_agg(DISTINCT value)
      FROM jsonb_array_elements_text(
        COALESCE(metadata->'tables', '[]'::jsonb) || '["flow_pauses"]'::jsonb
      ) AS t(value)
    ),
    TRUE
  ),
  updated_at = NOW()
WHERE metadata ? 'tables';

COMMIT;
