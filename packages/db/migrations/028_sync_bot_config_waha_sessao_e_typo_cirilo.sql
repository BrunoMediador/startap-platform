-- Migration 028: sincroniza bot_config.waha_sessao com flow_clones.waha_sessao
-- e corrige typo do nome da sessao do clone CIRILO no banco.
--
-- Bugs corrigidos:
--
-- 1) bot_config.waha_sessao NULL para clones:
--    POST /api/clones/with-waha (e retry-waha, bind-session) atualizava
--    flow_clones.waha_sessao mas NAO atualizava bot_config.waha_sessao do
--    mesmo slot. Como /api/bots le bot_config.waha_sessao para resolver o
--    nome da sessao WAHA, clones apareciam com waha_status=null no painel
--    mesmo conectados (memoria mapping_slot_waha_sessao). Esta migration
--    espelha os valores existentes em bot_config; o codigo do server.js
--    foi atualizado para manter a sincronia em mudancas futuras.
--
-- 2) Typo do nome da sessao do CIRILO:
--    Sessao WAHA real esta cadastrada como 'cirilo_barbaershop' (typo: 'a'
--    extra em 'barbershop'). flow_clones.waha_sessao foi populado como
--    'cirilos_barbershop' (sem typo, com 's' em cirilos). Resultado:
--    /api/sessions/cirilos_barbershop responde 404 e o painel mostra
--    estado inconsistente. Alinhamos o banco com a verdade do WAHA (menor
--    custo: sem stop/start de sessao em prod, sem perda de conexao do
--    cliente). UPDATE alvo apenas no clone afetado, idempotente.
--
-- Idempotente. Reversivel via UPDATE manual.

BEGIN;

-- 1. Corrige nome no flow_clones (alinhar com nome real no WAHA).
UPDATE flow_clones
SET waha_sessao = 'cirilo_barbaershop',
    updated_at  = NOW()
WHERE slot = 'clone_cirilos_barbershop_n5yzcd'
  AND waha_sessao = 'cirilos_barbershop';

-- 2. Backfill bot_config.waha_sessao a partir de flow_clones para todos os
--    clones que ainda tem bot_config.waha_sessao NULL e flow_clones.waha_sessao
--    preenchido. Usa NOT EXISTS para evitar sobrescrever vinculos manuais.
UPDATE bot_config bc
SET waha_sessao = fc.waha_sessao,
    updated_at  = NOW()
FROM flow_clones fc
WHERE bc.slot = fc.slot
  AND fc.waha_sessao IS NOT NULL
  AND fc.waha_sessao <> ''
  AND bc.waha_sessao IS NULL;

COMMIT;
