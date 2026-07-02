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
--   Guarda, na linha sintética DEDICADA '__heartbeat__' de alert_states, o instante do ÚLTIMO tick
--   do monitor. O job carimba last_cycle_at = NOW() a cada ciclo ativo -> a prova de vida passa a
--   ser verificável por SELECT (SELECT last_cycle_at FROM alert_states WHERE check_key='__heartbeat__'
--   -> vivo se now()-last_cycle_at < ~3min), além do log "monitor cycle" que agora sai em TODO
--   ciclo. NULL = nenhum tick registrado ainda.
--
-- POR QUE NUMA LINHA DEDICADA '__heartbeat__' (decisão do arquiteto, SCRUM-54):
--   Separar liveness do hard cap POR CONSTRUÇÃO. A __global__ já é outlier semântico (contador
--   anti-flood + window_start); empilhar liveness nela seria a 3ª semântica na mesma linha e abriria
--   dúvida de contenção. Com linha própria, o SELECT de liveness fica inequívoco e o carimbo nunca
--   toca down_since/alert_count do cap. Tabela dedicada (worker_heartbeats) foi descartada por ora
--   (over-engineering com 1 worker) — dívida de roadmap se um dia houver >1 worker.
--   Aditivo puro: a coluna é usada SÓ pela __heartbeat__; as demais linhas (waha:*, api:health,
--   pg:main, __global__) a mantêm NULL. A linha __heartbeat__ é INERTE na máquina de estado (o
--   monitor nunca a processa como check — igual à __global__).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + seed ON CONFLICT DO NOTHING. NÃO destrutiva: nenhum
--   DROP/DELETE/TRUNCATE; nenhuma coluna removida; nada na mesma release.
--
-- ── ROLLBACK (rodar manualmente; NUNCA no mesmo release que adiciona) ───────────────
--   BEGIN;
--   DELETE FROM alert_states WHERE check_key = '__heartbeat__';
--   ALTER TABLE alert_states DROP COLUMN IF EXISTS last_cycle_at;
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Heartbeat do último tick do monitor (carimbado na linha '__heartbeat__'). NULL = nenhum tick ainda.
ALTER TABLE alert_states ADD COLUMN IF NOT EXISTS last_cycle_at TIMESTAMPTZ;

-- Seed idempotente da linha dedicada (last_cycle_at NULL até o 1º tick). O recordCycleHeartbeat
-- também faz UPSERT, então isto é só pra o SELECT de liveness já retornar uma linha pós-migration.
INSERT INTO alert_states (check_key, state) VALUES ('__heartbeat__', 'up')
ON CONFLICT (check_key) DO NOTHING;

COMMIT;
