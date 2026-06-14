-- Migration 050: telefone/toggle do DONO do clone que RECEBE o alerta de cancelamento.
--
-- Missão 023 W5 — "cancelamento escalado": quando o cliente final pede CANCELAMENTO ao
-- bot de um barbeiro, o bot NÃO cancela; dispara um alerta pro DONO do clone (o barbeiro)
-- pela sessão remetente `ALERTAS` (W3 / migration 049). O dono então contata o cliente.
--
-- Por que coluna NOVA e não reusar flow_clones.cliente_telefone:
--   - `cliente_telefone` (migration 013) é "contato do cliente/dono cadastrado" — semântica
--     ambígua (nem sempre é o número que deve RECEBER alerta) e SEM liga/desliga.
--   - `alert_owner_phone` é, por contrato, o número E.164 (só dígitos) que recebe o alerta;
--     `alert_owner_enabled` dá o toggle por-clone (dono que não quer alerta; clone de teste).
--
-- Diferença pra alert_recipients (#295 / migration 046): aquela lista é o TIME INTERNO
-- (Bruno/plantão, GLOBAL, infra). Estas colunas são POR-TENANT (1 dono por clone, moram em
-- flow_clones). Os dois caminhos compartilham só o TRANSPORTE (sessão `ALERTAS` + sendText),
-- nunca a lista de destinatários.
--
-- ISOLAMENTO / multi-tenancy: colunas moram em flow_clones (a âncora do tenant), 1 linha por
-- clone. Aditivo puro — não piora a dívida P0 de multi-tenancy (segue por coluna `slot`).
-- tenant_id NÃO é necessário (a âncora já é a própria flow_clones).
--
-- BACKFILL: alert_owner_phone = dígitos de cliente_telefone (onde houver). alert_owner_enabled
-- nasce TRUE por DEFAULT (design W5) — mas a feature como um todo só age com a flag de ambiente
-- CANCELAMENTO_ESCALADO_ENABLED=true (default OFF, lição #247). Com a flag OFF, estas colunas
-- ficam inertes: o bot é IDÊNTICO ao de hoje. Ligar só após QA controlado no Cirilo.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE ... WHERE ... IS NULL.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida; nada na mesma release.
--
-- ── ROLLBACK (rodar manualmente; NUNCA no mesmo release que adiciona) ───────────────
--   BEGIN;
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS alert_owner_phone;
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS alert_owner_enabled;
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Telefone (E.164, só dígitos) que RECEBE o alerta de cancelamento do clone.
ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS alert_owner_phone VARCHAR(32);

-- Liga/desliga por-clone. DEFAULT TRUE (design W5). A flag de ambiente
-- CANCELAMENTO_ESCALADO_ENABLED (default OFF) é o gate macro; este toggle é o fino por-clone.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS alert_owner_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill: deriva o telefone do dono a partir de cliente_telefone (só dígitos), onde houver
-- e onde alert_owner_phone ainda esteja vazio. Não sobrescreve valor já preenchido.
UPDATE flow_clones
SET alert_owner_phone = NULLIF(regexp_replace(cliente_telefone, '\D', '', 'g'), '')
WHERE alert_owner_phone IS NULL
  AND cliente_telefone IS NOT NULL;

COMMIT;
