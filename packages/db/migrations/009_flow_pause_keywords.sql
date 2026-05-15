-- Migration 009: palavras-chave editaveis para pausar/retomar por fluxo.
-- Idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS flow_pause_keywords (
  flow_id       VARCHAR(100) NOT NULL,
  command       VARCHAR(10) NOT NULL CHECK (command IN ('pause','resume')),
  keyword       TEXT NOT NULL,
  keyword_norm  TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_id, command, keyword_norm)
);

CREATE INDEX IF NOT EXISTS idx_flow_pause_keywords_flow
  ON flow_pause_keywords (flow_id, enabled);

WITH flows(flow_id) AS (
  VALUES
    ('0ni38aSspWwhooHd'),
    ('dlpKXM3gvX2joC1b'),
    ('teste_vendas_barbearia'),
    ('uUS3Ux1cU2DquKxo')
),
defaults(command, keyword, keyword_norm) AS (
  VALUES
    ('pause', 'startap aqui!!', 'startapaqui!!'),
    ('pause', 'atendente aqui!!', 'atendenteaqui!!'),
    ('pause', 'humano aqui!!', 'humanoaqui!!'),
    ('pause', 'ricardo aqui!!', 'ricardoaqui!!'),
    ('resume', 'startap voltar!!', 'startapvoltar!!'),
    ('resume', 'ia voltar!!', 'iavoltar!!'),
    ('resume', 'bot voltar!!', 'botvoltar!!'),
    ('resume', 'ricardo voltar!!', 'ricardovoltar!!')
)
INSERT INTO flow_pause_keywords (flow_id, command, keyword, keyword_norm, enabled, updated_at)
SELECT flows.flow_id, defaults.command, defaults.keyword, defaults.keyword_norm, TRUE, NOW()
FROM flows
CROSS JOIN defaults
ON CONFLICT (flow_id, command, keyword_norm) DO NOTHING;

UPDATE project_databases
SET metadata = jsonb_set(
    metadata,
    '{tables}',
    (
      SELECT jsonb_agg(DISTINCT value)
      FROM jsonb_array_elements_text(
        COALESCE(metadata->'tables', '[]'::jsonb) || '["flow_pause_keywords"]'::jsonb
      ) AS t(value)
    ),
    TRUE
  ),
  updated_at = NOW()
WHERE metadata ? 'tables';

COMMIT;
