-- Migration 062: flow_clones.first_connected_at — carimbo de "este clone JÁ pareou alguma vez".
--
-- MOTIVO (bug provado em produção, Seven 7 / clone_barbearia_seven_7_barber_dqjzb4):
--   O monitor de sessões (alerts.listMonitoredSessions, Missão 021) só vigia clones com
--   status='conectado'. Quando uma sessão CAI (device_removed/FAILED), o sync do painel-admin
--   (WAHA_STATUS_MAP: FAILED/STOPPED -> 'desconectado', server.js) flipa flow_clones.status para
--   'desconectado' em ~60s. Resultado: a sessão SAI da lista de vigiados NO INSTANTE em que cai
--   -> o monitor NUNCA observa a transição up->down -> NUNCA alerta (nem o Bruno, nem o cliente).
--   Seven 7 ficou FAILED ~20 min sem um único alerta; alert_states dele seguiu 'up'.
--
-- POR QUE UMA COLUNA NOVA (e não inferir do status):
--   Precisamos distinguir "clone que JÁ conectou e agora caiu" (incidente real -> ALERTAR) de
--   "clone em PRÉ-SETUP que nunca conectou" (rascunho/aguardando_qr/falhou -> FAILED é ESPERADO,
--   NÃO alertar). O status sozinho não carrega essa história: um clone novo nunca-pareado e um
--   clone pareado-e-caído podem ambos aparecer como 'desconectado'/'falhou'. `first_connected_at`
--   é o sinal explícito e durável de "ever paired": uma vez gravado, nunca volta a NULL.
--
-- COMO É PREENCHIDO: markCloneConnectedBySlot (apps/api, hook do 1º WORKING da sessão —
--   trial-pairing) passa a carimbar first_connected_at = NOW() na MESMA UPDATE que vira o status
--   p/ 'conectado', SÓ na 1ª vez (COALESCE preserva o valor — idempotente, nunca sobrescreve).
--
-- BACKFILL: todo clone que HOJE está/esteve conectado já é "ever paired". Carimba os que estão
--   em status 'conectado' OU 'desconectado' e ainda têm first_connected_at NULL. Usa updated_at
--   como melhor aproximação do instante de conexão (não temos histórico). Clones em pré-setup
--   (rascunho/aguardando_qr) e 'falhou' nunca-pareados ficam NULL de propósito -> seguem fora do
--   monitor (anti-pré-setup preservado).
--
-- ISOLAMENTO / multi-tenancy: coluna mora em flow_clones (a âncora do tenant), 1 linha por clone.
--   Aditivo puro — não piora a dívida P0 de multi-tenancy (segue por coluna `slot`). tenant_id NÃO
--   é necessário (a âncora já é a própria flow_clones).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE ... WHERE first_connected_at IS NULL.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida; nada na mesma release.
--
-- ── ROLLBACK (rodar manualmente; NUNCA no mesmo release que adiciona) ───────────────
--   BEGIN;
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS first_connected_at;
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Carimbo do 1º pareamento bem-sucedido (NULL = nunca conectou = pré-setup).
ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS first_connected_at TIMESTAMPTZ;

-- Backfill: clones que JÁ estão/estiveram conectados são "ever paired". Aproxima o instante por
-- updated_at (não há histórico). Pré-setup (rascunho/aguardando_qr) e 'falhou' nunca-pareados
-- ficam NULL — seguem fora do monitor (não geram falso CAIU).
UPDATE flow_clones
SET first_connected_at = updated_at
WHERE first_connected_at IS NULL
  AND status IN ('conectado', 'desconectado');

COMMIT;
