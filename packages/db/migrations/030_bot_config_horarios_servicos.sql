-- Migration 030: espelha horarios_funcionamento e servicos em bot_config.
--
-- Bruno (2026-05-20): "todas melhorias que estamos fazendo pra o cirilo deve
-- ter tambem na matriz, principalmente a matriz que nos clonamos".
--
-- Antes: horarios e servicos so existiam em flow_clones (por clone). A matriz
-- teste_barbearia dependia de defaults hardcoded no codigo (getCloneDefaults
-- no painel, BUILTIN_DEFAULTS no worker). Cada vez que mudasse, precisa
-- redeploy.
--
-- Agora: bot_config (uma linha por bot, incluindo a matriz) tambem armazena
-- esses jsonb. Painel ganha abas pra editar a matriz. Quando cria clone
-- novo, herda os valores da matriz. Worker, ao rodar pra matriz direto,
-- le de bot_config (em vez de cair em BUILTIN_DEFAULTS hardcoded).
--
-- Seed: aplica os mesmos 4 servicos default (Corte/Barba/Sobrancelha/Pezinho
-- R$50 30min) e horarios ter-sab 09-18 na matriz teste_barbearia. Idempotente:
-- so escreve se ainda for NULL.

BEGIN;

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS horarios_funcionamento jsonb,
  ADD COLUMN IF NOT EXISTS servicos jsonb;

-- Seed na matriz teste_barbearia
UPDATE bot_config
SET horarios_funcionamento = jsonb_build_object(
      'segunda',  jsonb_build_object('abre', NULL,    'fecha', NULL,    'fechado', true),
      'terca',    jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'quarta',   jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'quinta',   jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'sexta',    jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'sabado',   jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'domingo',  jsonb_build_object('abre', NULL,    'fecha', NULL,    'fechado', true)
    ),
    updated_at = NOW()
WHERE slot = 'teste_barbearia'
  AND horarios_funcionamento IS NULL;

UPDATE bot_config
SET servicos = '[
  {"nome": "Corte", "preco_cents": 5000, "duracao_min": 30},
  {"nome": "Barba", "preco_cents": 5000, "duracao_min": 30},
  {"nome": "Sobrancelha", "preco_cents": 5000, "duracao_min": 30},
  {"nome": "Pezinho", "preco_cents": 5000, "duracao_min": 30}
]'::jsonb,
    updated_at = NOW()
WHERE slot = 'teste_barbearia'
  AND servicos IS NULL;

COMMIT;
