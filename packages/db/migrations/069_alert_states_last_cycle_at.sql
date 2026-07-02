-- Migration 069: alert_states.last_cycle_at — heartbeat de liveness do job monitor (SCRUM-54).
--
-- MOTIVO (falso diagnóstico em produção, 02/07):
--   O ciclo do monitor (apps/worker, Missão 021) só logava quando havia atividade (down>0). Com
--   TUDO saudável o worker ficava mudo — e "saudável e quieto" era indistinguível de "travado".
--   Na triagem da ALERTAS um verificador concluiu que o monitor estava travado quando ele estava
--   vivo e apenas silencioso (o único check DOWN tinha saído da lista via delete-clone no mesmo
--   minuto) -> restart desnecessário.
--
-- O QUE ESTA COLUNA FAZ:
--   Guarda, na linha sintética '__global__' de alert_states, o instante do ÚLTIMO tick do monitor.
--   O job carimba last_cycle_at = NOW() a cada ciclo ativo -> a prova de vida passa a ser
--   verificável por SELECT (SELECT last_cycle_at FROM alert_states WHERE check_key='__global__'),
--   além do log "monitor cycle" que agora sai em TODO ciclo. NULL = nenhum tick registrado ainda.
--
-- POR QUE NA __global__ (e não numa tabela nova):
--   A __global__ já é a linha de estado global do monitor (hard cap de mensagens por janela).
--   O heartbeat é global (o monitor é 1 job do time, sem tenant) -> mora junto. Aditivo puro: a
--   coluna é usada SÓ pela __global__; as demais linhas (waha:*, api:health, pg:main) a mantêm NULL.
--   O carimbo é um UPDATE isolado de last_cycle_at — NÃO toca down_since (window_start) nem
--   alert_count (contador da janela) usados pelo hard cap.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma
--   coluna removida; nada na mesma release.
--
-- ── ROLLBACK (rodar manualmente; NUNCA no mesmo release que adiciona) ───────────────
--   BEGIN;
--   ALTER TABLE alert_states DROP COLUMN IF EXISTS last_cycle_at;
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Heartbeat do último tick do monitor (carimbado na linha '__global__'). NULL = nenhum tick ainda.
ALTER TABLE alert_states ADD COLUMN IF NOT EXISTS last_cycle_at TIMESTAMPTZ;

COMMIT;
