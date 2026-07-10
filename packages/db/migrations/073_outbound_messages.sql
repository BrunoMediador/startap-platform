-- Migration 073: outbound_messages — rastreio de ENTREGA por outbound WhatsApp (SCRUM-58).
--
-- MOTIVO (cegueira à entrega, incidentes SCRUM-55/463):
--   Hoje o app loga `bot.reply-sent` no HTTP 2xx do WAHA — mas 2xx só quer dizer "WAHA aceitou
--   o envio". O `ack error:463` (NackCallerReachoutTimelocked) e outros nacks acontecem DEPOIS,
--   no nível do WhatsApp, e NINGUÉM sabe: o Bruno perguntou "chegou?" no teste; a Lola ficou
--   3 DIAS muda sem alerta. Esta tabela guarda, por mensagem enviada, o último status de ack
--   observado (PENDING→SERVER→DEVICE→READ, ou ERROR/nack) pra o worker ALERTAR nack terminal e
--   outbound preso sem entrega.
--
-- O QUE A TABELA GUARDA (1 linha por mensagem enviada, PK = message_id do WAHA):
--   - message_id  = id serializado do WAHA (correlaciona o envio com o evento message.ack).
--   - session     = sessão WAHA que enviou.
--   - slot        = clone dono (fronteira de tenant; NULL pra envios sem clone, ex.: alertas).
--   - phone_hint  = telefone MASCARADO (LGPD — NUNCA número em claro; ver phoneHint no core).
--   - ack_status  = status normalizado (ERROR|PENDING|SERVER|DEVICE|READ). Default PENDING no envio.
--   - ack_rank    = rank monotônico (ERROR=-1 .. READ=3) pra o UPDATE "só sobe" ser atômico.
--   - ack_code    = último ack numérico bruto observado (-1..4). NULL até o 1º ack.
--   - alerted_at  = quando o time foi avisado deste outbound (nack terminal OU preso). NULL = não.
--
-- LGPD: SEM telefone em claro/CPF — só o hint mascarado. NUNCA guarda conteúdo da mensagem.
--
-- ISOLAMENTO / multi-tenancy (regra de ouro 5): `slot` é a fronteira de tenant (mesma dívida P0
--   conhecida: slot-string sem RLS). Aditivo puro — não toca nenhuma linha/coluna existente.
--
-- GATE: TODO uso (registro no envio + handler do ack + alerta do worker) está atrás da flag
--   MESSAGE_ACK_TRACKING_ENABLED (default OFF). Com a flag OFF NINGUÉM escreve aqui — a tabela
--   nasce vazia e inerte (byte-idêntico ao de hoje). A assinatura do evento `message.ack` na
--   config das sessões WAHA é passo de deploy SEPARADO.
--
-- RETENÇÃO: linhas são efêmeras (tracking, não fonte de verdade de negócio). O worker poda as
--   antigas (MESSAGE_ACK_RETENTION_DAYS) — mesmo padrão de flow_execution_logs.pruneOldFlowEvents.
--
-- IDEMPOTENTE: CREATE TABLE/INDEX IF NOT EXISTS — re-rodar é no-op. NÃO destrutiva: nenhum
--   DROP/DELETE/TRUNCATE; nenhuma coluna removida; nada na mesma release (regra de ouro 9).
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação do Bruno) ──
--   BEGIN;
--   DROP TABLE IF EXISTS outbound_messages;
--   COMMIT;
--   → o rastreio some. Com MESSAGE_ACK_TRACKING_ENABLED OFF nada mais depende desta tabela.
-- ───────────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS outbound_messages (
  -- id serializado do WAHA da mensagem enviada (correlação com o evento message.ack).
  message_id  TEXT        PRIMARY KEY,
  session     TEXT        NOT NULL,
  -- clone dono (fronteira de tenant). NULL pra envios sem clone (ex.: alertas internos).
  slot        TEXT,
  -- telefone MASCARADO (LGPD). NUNCA número em claro.
  phone_hint  TEXT        NOT NULL,
  ack_status  TEXT        NOT NULL DEFAULT 'PENDING'
                CHECK (ack_status IN ('ERROR', 'PENDING', 'SERVER', 'DEVICE', 'READ')),
  -- rank monotônico do status (ERROR=-1, PENDING=0, SERVER=1, DEVICE=2, READ=3).
  ack_rank    INTEGER     NOT NULL DEFAULT 0,
  -- último ack numérico bruto observado (-1..4). NULL até o 1º ack.
  ack_code    INTEGER,
  -- quando o time foi avisado deste outbound (nack terminal OU preso sem entrega). NULL = não.
  alerted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE outbound_messages IS
  'Rastreio de entrega por outbound WhatsApp (SCRUM-58). 1 linha por mensagem enviada; status via evento message.ack. Gated por MESSAGE_ACK_TRACKING_ENABLED. LGPD: só phone_hint mascarado, sem conteúdo.';
COMMENT ON COLUMN outbound_messages.phone_hint IS
  'Telefone MASCARADO (LGPD). NUNCA número em claro/CPF.';
COMMENT ON COLUMN outbound_messages.ack_rank IS
  'Rank monotônico do ack_status (ERROR=-1 .. READ=3) pro UPDATE "só sobe" ser atômico.';
COMMENT ON COLUMN outbound_messages.alerted_at IS
  'Quando o time foi alertado deste outbound (nack terminal / preso sem entrega). NULL = não avisado.';

-- Varredura do worker: nacks terminais e presos sem entrega ainda NÃO alertados, priorizando os
-- mais antigos. Cobre (ack_status='ERROR' AND alerted_at IS NULL) e (PENDING/SERVER velhos).
CREATE INDEX IF NOT EXISTS ix_outbound_messages_alertable
  ON outbound_messages (ack_status, created_at)
  WHERE alerted_at IS NULL;

-- Poda por idade (retenção) — mesmo padrão do prune de flow_execution_logs.
CREATE INDEX IF NOT EXISTS ix_outbound_messages_created_at
  ON outbound_messages (created_at);

COMMIT;
