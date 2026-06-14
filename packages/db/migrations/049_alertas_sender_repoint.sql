-- Migration 049: repoint do REMETENTE de todos os alertas para a sessão dedicada `ALERTAS`.
--
-- Missão 023 W3. Bruno criou uma sessão WAHA dedicada (`ALERTAS`, +55 35 99924-7411,
-- WORKING, send-capable, sem webhook — só ENVIA) pra ser o remetente único de TODOS
-- os alertas: os internos do time (#295 / Missão 021) e os futuros de cliente (W5).
-- Isso libera a Lola (STARTAP_AI_PROD) pra prospecção.
--
-- ESTRATÉGIA — repoint por DADO, não por código. A indireção já existe:
--   alert_config.sender_slot  ──►  bot_config.waha_sessao
-- (resolvida por alerts.getSenderSession). Hoje sender_slot='startap' → Lola.
-- Esta migration:
--   1) garante um SLOT DE PLATAFORMA `alertas` em bot_config com waha_sessao='ALERTAS'
--      (espelha o slot `startap` — é INFRA do time, NÃO é tenant: NÃO cria flow_clones,
--      NÃO cria tenant_id). Assim getSenderSession('alertas') → 'ALERTAS';
--   2) UPDATE alert_config SET sender_slot='alertas'.
-- Depois disso, monitor (worker), sendInternalAlert (#295) e POST /api/alerts/test
-- (painel) — todos resolvem o remetente via sender_slot — passam a enviar pela `ALERTAS`.
-- ZERO mudança de código de comportamento.
--
-- ISOLAMENTO / multi-tenancy: o slot `alertas` é só uma linha em bot_config (mesma
-- natureza de `startap`/Lola). NÃO entra em flow_clones, então NÃO é monitorado como
-- cliente (listMonitoredSessions filtra por flow_clones), só como remetente. Não toca
-- sessão/dado de nenhum cliente. Aditivo puro — não piora a dívida P0 de multi-tenancy.
--
-- NÃO mexe em alert_config.enabled (kill-switch é decisão/ação do Bruno depois), NÃO
-- mexe em alert_recipients.
--
-- Idempotente: INSERT ... ON CONFLICT DO NOTHING + UPDATE ... WHERE.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida.
--
-- ── ROLLBACK (rodar manualmente; NUNCA no mesmo release) ─────────────────────────
--   BEGIN;
--   UPDATE alert_config SET sender_slot = 'startap', updated_at = NOW() WHERE id = 1;
--   DELETE FROM bot_config WHERE slot = 'alertas';
--   COMMIT;
--   → remetente volta pra Lola (STARTAP_AI_PROD) instantaneamente; slot `alertas` some.
-- ─────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Slot de plataforma `alertas` (remetente dedicado). provider/model só satisfazem
--    NOT NULL + CHECK do bot_config — a sessão `ALERTAS` SÓ ENVIA, nunca roda agente,
--    então o modelo é irrelevante (espelha o default da Lola: deepseek/deepseek-chat).
INSERT INTO bot_config (slot, display_name, provider, model, temperature, waha_sessao)
VALUES ('alertas', 'Alertas (remetente)', 'deepseek', 'deepseek-chat', 0.3, 'ALERTAS')
ON CONFLICT (slot) DO NOTHING;

-- Cinto extra: se o slot `alertas` já existir de uma execução parcial sem waha_sessao,
-- garante o mapeamento pra sessão dedicada (idempotente; só preenche quando vazio).
UPDATE bot_config
SET waha_sessao = 'ALERTAS'
WHERE slot = 'alertas' AND (waha_sessao IS NULL OR waha_sessao = '');

-- 2) Repoint: todos os alertas passam a sair pela sessão `ALERTAS`.
UPDATE alert_config SET sender_slot = 'alertas', updated_at = NOW() WHERE id = 1;

COMMIT;
