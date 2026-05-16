-- Migration 012: corrige positions descritivas do slot teste_vendas_barbearia
--
-- Bug: sendCourseVideos() buscava por 'V1', 'V2', 'V3', 'POS_VIDEOS' (match exato),
-- mas as linhas em bot_media tinham nomes descritivos inseridos manualmente.
-- Resultado: getByPosition retornava null para todos e zero videos eram enviados.
--
-- Mapeamento (ordem editorial: degradê demo primeiro, depois presença de alunos):
--   demo_corte_degrade_1         → V1
--   demo_corte_degrade_2         → V2
--   presencial_alunos_formados   → V3
--   presencial_alunos_cortando   → mantido (reserva, Bruno reordena pelo painel)
--   online_degrade_apresentacao  → POS_VIDEOS (texto pós-videos que o código envia via caption)

BEGIN;

UPDATE bot_media
SET position = 'V1'
WHERE slot = 'teste_vendas_barbearia'
  AND position = 'demo_corte_degrade_1';

UPDATE bot_media
SET position = 'V2'
WHERE slot = 'teste_vendas_barbearia'
  AND position = 'demo_corte_degrade_2';

UPDATE bot_media
SET position = 'V3'
WHERE slot = 'teste_vendas_barbearia'
  AND position = 'presencial_alunos_formados';

UPDATE bot_media
SET position = 'POS_VIDEOS'
WHERE slot = 'teste_vendas_barbearia'
  AND position = 'online_degrade_apresentacao';

-- presencial_alunos_cortando permanece com nome descritivo (não usada hoje)

COMMIT;
