-- Migration 067: contact_classification — CACHE de veredito do bot-detect (SCRUM-4 PR-C).
--
-- CONTEXTO (SCRUM-4): detectar quando OUTRO bot/empresa (não um cliente humano) conversa com o
-- nosso bot — inclusive quando imita ritmo humano (1–2 msgs por turno) — e MARCAR o número, sem
-- nunca pausar um cliente real. A detecção roda no WORKER (job bot-detect), 1× por número novo,
-- com cache do veredito por (clone, telefone). Esta tabela É esse cache: classifica uma vez e nunca
-- reprocessa o mesmo número (candidato = quem NÃO está aqui ainda).
--
-- FASE 1 (esta release): só HEURÍSTICA barata + ALERTA ao dono (alert-only). NÃO pausa ninguém.
--   - `verdict`/`confidence`/`signals`/`source`/`decided_at` = resultado da classificação.
--   - `alerted_at` = quando o dono foi avisado (1× por número). NULL = ainda não avisado.
--   - `paused_at`  = reservado pra PR-E (auto-pausa). NUNCA escrito na Fase 1 (alert-only). Existe
--                    desde já pra a transição PR-E ser ADITIVA (sem nova migration de coluna).
--
-- POR QUE PK (flow_id, telefone): no modelo atual slot↔clone↔tenant é 1:1. `flow_id` = o slot do
--   clone (mesma semântica de flow_pauses/antibot.flowId). Cada número é classificado por clone —
--   o mesmo telefone pode ser cliente real num clone e bot noutro. Isolamento = a própria PK.
--
-- ISOLAMENTO / multi-tenancy (regra de ouro 5): `flow_id` (slot) é a fronteira de tenant. NÃO há
--   `tenant_id` aqui de propósito — o job resolve o slot a partir da SESSÃO WAHA do clone (derivado,
--   nunca de input) e escopa toda leitura/escrita por `flow_id`. Acompanha a dívida P0 conhecida
--   (slot-string sem RLS) sem PIORÁ-LA: aditivo puro, nenhuma linha/coluna existente é tocada.
--
-- LGPD: a tabela guarda o telefone (necessário pra o cache funcionar — mesma exposição de
--   message_log/flow_pauses, que já carregam o número). NUNCA grava conteúdo de mensagem em claro;
--   `signals` é só o sumário booleano/numérico da heurística (sem PII). Logs do job mascaram o
--   telefone (phoneHint). `signals` NÃO contém texto da conversa.
--
-- IDEMPOTENTE: CREATE TABLE/INDEX IF NOT EXISTS — re-rodar é no-op. NÃO destrutiva: nenhum
--   DROP/DELETE/TRUNCATE; nenhuma coluna removida; nada na mesma release.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação do Bruno) ──
--   BEGIN;
--   DROP TABLE IF EXISTS contact_classification;
--   COMMIT;
--   → o cache some. O job bot-detect (gated OFF por default) deixa de ter onde gravar veredito;
--     nada mais depende desta tabela (Fase 1 não pausa, não escreve em flow_pauses).
-- ───────────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS contact_classification (
  -- Slot do clone (mesma semântica de flow_pauses.flowId / antibot). Fronteira de tenant.
  flow_id     TEXT        NOT NULL,
  -- Telefone do número classificado (dígitos, como em message_log.phone).
  telefone    TEXT        NOT NULL,
  -- Veredito da classificação. 'gray' reservado pra zona-cinza do pipeline híbrido (PR-D/LLM);
  -- a Fase 1 grava só 'bot' | 'human'.
  verdict     TEXT        NOT NULL CHECK (verdict IN ('bot', 'human', 'gray')),
  -- Confiança 0..1. Na Fase 1 (heurística) = valor derivado dos sinais; na PR-D vem do LLM.
  confidence  NUMERIC(4,3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  -- Sumário dos sinais que dispararam (booleanos/numéricos). SEM texto de conversa / SEM PII.
  signals     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Como o veredito foi decidido: 'allowlist' (já agendou / número interno), 'heuristic' (Fase 1),
  -- 'llm' (PR-D, zona-cinza).
  source      TEXT        NOT NULL CHECK (source IN ('allowlist', 'heuristic', 'llm')),
  -- Quando o veredito foi decidido.
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Quando o dono foi avisado (Fase 1 alert-only). NULL = veredito 'bot' ainda não alertado, ou
  -- veredito 'human' (não alerta).
  alerted_at  TIMESTAMPTZ,
  -- Reservado pra PR-E (auto-pausa após carência). NUNCA escrito na Fase 1.
  paused_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_id, telefone)
);

COMMENT ON TABLE contact_classification IS
  'Cache de veredito do bot-detect (SCRUM-4). 1 linha por (clone, telefone) classificado. Fase 1 = heurística + alerta; não pausa. paused_at reservado pra PR-E.';
COMMENT ON COLUMN contact_classification.signals IS
  'Sumário booleano/numérico dos sinais (timing/conteúdo). NUNCA texto de conversa / PII.';
COMMENT ON COLUMN contact_classification.alerted_at IS
  'Quando o dono foi avisado do bot (1× por número). NULL = ainda não avisado / veredito humano.';
COMMENT ON COLUMN contact_classification.paused_at IS
  'Reservado pra PR-E (auto-pausa). NÃO usado na Fase 1 (alert-only).';

-- Relatório/varredura de bots pendentes de alerta por clone (verdict='bot' AND alerted_at IS NULL).
CREATE INDEX IF NOT EXISTS ix_contact_classification_flow_verdict
  ON contact_classification (flow_id, verdict);

COMMIT;
