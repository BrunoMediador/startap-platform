-- Migration 078: alert_states.host_reported_pct/host_reported_at — check host:disk (SCRUM-134).
--
-- MOTIVO:
--   Missão 021 (spec docs/missoes/021-sistema-alertas-interno.md) já reservou o check `host:disk`
--   e a coluna `alert_config.check_host` desde a migration 046, mas registrou como "fase 2" porque
--   o worker é containerizado e enxerga cgroup/overlay, não o disco físico do host (mesmo texto:
--   "disco/RAM ficam pra fase 2 (worker enxerga cgroup, não o host)"). Essa fase 2 nunca foi
--   implementada — o script `/opt/automacoes/disco-alerta.sh` (cron 6/6h no HOST) mede o disco
--   certo, mas só grava num log local que ninguém lê (canal de notificação comentado). Resultado:
--   alerta CEGO — falsa sensação de cobertura.
--
-- DESENHO (por que 2 colunas numa linha SINTÉTICA, não reaproveitar state/alert_count):
--   `state`/`down_since`/`alert_count`/`pending_down_count` são domínio EXCLUSIVO da máquina de
--   transição do monitor (applyTransition, apps/worker/src/jobs/monitor.ts) — CAS otimista entre
--   ciclos concorrentes. Um script bash externo escrevendo ali colidiria com esse contrato. Em vez
--   disso, replica o padrão JÁ validado de last_cycle_at (migration 069, heartbeat): um PRODUTOR
--   externo carimba um FATO bruto numa linha dedicada; o CONSUMIDOR (o worker) lê o fato e alimenta
--   a máquina de estado normalmente via observeHostDisk() (código à parte, não nesta migration).
--   host_reported_pct = % de uso reportado pelo `df /` do HOST na última coleta.
--   host_reported_at  = timestamp dessa coleta (permite o worker detectar STALENESS — script sem
--                        rodar há muito tempo, cron 6/6h; ausência de dado fresco é sinal, não silêncio).
--   A linha 'host:disk' é escrita pelo script via `startap_app` (role já tem INSERT/UPDATE/SELECT/
--   DELETE nesta tabela — sem escalar privilégio) e fica INERTE quanto a state/alert_count até o
--   worker processá-la (igual __heartbeat__/__global__ são inertes pro lado oposto).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma
--   coluna removida; nada mais na mesma release. NÃO mexe em alert_config.check_host (segue FALSE
--   — ligar é decisão do Bruno, fora desta migration).
--
-- ── ROLLBACK (rodar manualmente; NUNCA no mesmo release que adiciona) ───────────────
--   BEGIN;
--   DELETE FROM alert_states WHERE check_key = 'host:disk';
--   ALTER TABLE alert_states DROP COLUMN IF EXISTS host_reported_pct;
--   ALTER TABLE alert_states DROP COLUMN IF EXISTS host_reported_at;
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE alert_states ADD COLUMN IF NOT EXISTS host_reported_pct SMALLINT;
ALTER TABLE alert_states ADD COLUMN IF NOT EXISTS host_reported_at TIMESTAMPTZ;

-- Seed idempotente da linha dedicada (valores NULL até a 1ª coleta do script no host).
-- Inerte na máquina de estado: o monitor só a processa via observeHostDisk() (leitura), nunca
-- via applyTransition direto sobre esta linha como se fosse um check observado no ciclo.
INSERT INTO alert_states (check_key, state) VALUES ('host:disk', 'up')
ON CONFLICT (check_key) DO NOTHING;

COMMIT;
