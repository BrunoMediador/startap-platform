-- Migration 060: Lembrete de agendamento — one-way, configurável POR CLONE pelo dono.
--
-- Fonte = tabela `atendimentos` (migration 058/059), origem='agenda'. O worker varre
-- atendimentos cujo inicio_at cai numa janela configurada (ex.: 24h/2h antes) e dispara
-- 1 WhatsApp pela sessão WAHA do PRÓPRIO clone (flow_clones.waha_sessao). MVP one-way:
-- só envia, sem confirmar/cancelar por resposta.
--
-- COLUNAS NOVAS em `flow_clones` (todas ADITIVAS, default seguro = OFF/global):
--   * reminders_enabled       — o dono LIGA o lembrete por clone (default false = nasce
--                               desligado; nenhum clone existente passa a enviar nada).
--   * reminder_windows_min    — janelas (minutos antes do horário) que ele quer. INT[].
--                               NULL = usa o DEFAULT GLOBAL do worker (ex.: [1440,120]).
--                               Conjunto permitido validado no app: 1440(24h)/180(3h)/
--                               120(2h)/60(1h).
--   * reminder_template       — texto do lembrete. NULL = usa o template DEFAULT do worker
--                               (PT-BR, com vars {cliente_nome}/{servico_nome}/{horario}/
--                               {profissional}/{negocio}).
--
-- TABELA NOVA `reminder_log` — CLAIM idempotente + auditoria do envio:
--   UNIQUE (atendimento_id, window_min, inicio_at) = 1 lembrete por evento/janela/horário-
--   alvo. Remarcação muda inicio_at do atendimento -> chave NOVA legítima (o cliente é
--   lembrado do horário novo). O worker tenta INSERT antes de enviar: conflito = já foi
--   reservado/enviado -> pula (idempotência sob retry/cron sobreposto).
--   FK atendimento_id -> atendimentos(id) ON DELETE CASCADE: deletar o atendimento limpa o
--   log junto (sem órfão). slot + tenant_id em TODA linha (regra de ouro 5, caminho RLS
--   futuro ADR 0018). INDEX por tenant_id (defesa em profundidade).
--
-- ISOLAMENTO: cada lembrete sai pela sessão do PRÓPRIO clone (nunca cross-cliente). O log
--   carrega slot + tenant_id, ambos resolvidos do atendimento/clone (nunca de input).
--
-- DORMENTE por flag: o worker só registra o cron com REMINDERS_ENABLED=true (global, default
--   OFF) E só processa clones com reminders_enabled=true. Com tudo OFF nada é lido/enviado.
--
-- ADITIVA: só ADD COLUMN IF NOT EXISTS + CREATE TABLE/INDEX IF NOT EXISTS. SEM backfill, SEM
--   tocar linha existente. Nenhum pagante afetado.
--
-- Idempotente: re-rodar é no-op (IF NOT EXISTS em coluna/tabela/índice). NÃO destrutiva:
--   nenhum DROP/DELETE/TRUNCATE sobre dado existente.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação
--    explícita do Bruno) ──────────────────────────────────────────────────────────────
--   BEGIN;
--     DROP TABLE IF EXISTS reminder_log;                 -- apaga só o log de envios
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS reminder_template;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS reminder_windows_min;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS reminders_enabled;
--   COMMIT;
--   → tabela e colunas somem; produção idêntica a antes. Flag OFF = nenhum pagante afetado.
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- O dono LIGA o lembrete por clone. Default false = nasce desligado (nenhum envio sem opt-in).
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT false;

-- Janelas (minutos antes do horário). NULL = usa o default global do worker.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS reminder_windows_min INT[];

-- Template do texto. NULL = usa o template default do worker.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS reminder_template TEXT;

COMMENT ON COLUMN flow_clones.reminders_enabled IS
  'Lembrete de agendamento ligado POR CLONE pelo dono (one-way). Default false. Migration 060.';
COMMENT ON COLUMN flow_clones.reminder_windows_min IS
  'Janelas (min antes do horário) do lembrete. NULL = default global do worker. Migration 060.';
COMMENT ON COLUMN flow_clones.reminder_template IS
  'Template do texto do lembrete. NULL = template default do worker (PT-BR). Migration 060.';

CREATE TABLE IF NOT EXISTS reminder_log (
  id              BIGSERIAL    PRIMARY KEY,
  atendimento_id  BIGINT       NOT NULL REFERENCES atendimentos(id) ON DELETE CASCADE,
  slot            TEXT         NOT NULL,                 -- isolamento (regra de ouro 5)
  tenant_id       UUID         NOT NULL,                 -- carimbado do clone (ADR 0018)
  window_min      INT          NOT NULL,                 -- a janela que disparou (1440/120/...)
  inicio_at       TIMESTAMPTZ  NOT NULL,                 -- horário-alvo do atendimento no ato
  status          VARCHAR(16)  NOT NULL DEFAULT 'sent',  -- sent | failed (validado no app)
  sent_at         TIMESTAMPTZ,                           -- quando saiu (null enquanto failed/claim)
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE reminder_log IS
  'CLAIM idempotente + auditoria do lembrete de agendamento (one-way). 1 lembrete por '
  'evento/janela/horário-alvo (UNIQUE atendimento_id,window_min,inicio_at). Remarcar muda '
  'inicio_at -> chave nova legítima. slot+tenant_id em toda linha (RLS). Migration 060.';

-- CLAIM idempotente: o worker INSERT antes de enviar; conflito = já reservado -> pula.
CREATE UNIQUE INDEX IF NOT EXISTS ux_reminder_log_evento_janela
  ON reminder_log (atendimento_id, window_min, inicio_at);

-- Escopo por tenant (defesa em profundidade RLS).
CREATE INDEX IF NOT EXISTS ix_reminder_log_tenant
  ON reminder_log (tenant_id);

COMMIT;
