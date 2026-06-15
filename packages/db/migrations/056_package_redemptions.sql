-- Migration 056: package_redemptions — LEDGER imutável append-only, FONTE DA VERDADE do saldo.
--
-- ADR 0025 (pacotes de serviço) §2/§3. BLOCO 2a — aqui SÓ criamos o schema. Esta tabela
-- só será ESCRITA no bloco 2b (dedução transacional dentro de inserir_agendamento,
-- sob action-lock do ADR 0019). NÃO há escrita nesta tabela neste PR.
--
-- Tabela NOVA. Toda linha carrega slot + tenant_id UUID. Cada linha é um movimento de
-- saldo (delta) ligado a um evento do Google Calendar (gcal_event_id):
--   * delta = -1, reason='redeem' -> consumo (1 sessão); +1, reason='refund' -> estorno.
--   * reason='adjust' -> ajuste manual/reconciliação (ledger nunca é editado; só append).
-- sessoes_restantes em client_package_credits = sessoes_total + SUM(delta) deste ledger.
--
-- IDEMPOTÊNCIA (escopo EXATO — ADR 0025 §3 + dívida 5):
--   UNIQUE(gcal_event_id, reason) garante que o MESMO gcal_event_id nunca desconta 2x
--   nem estorna 2x (ACK-early/retry do MESMO evento não duplica saldo). NÃO cobre o
--   ciclo cancelar+reagendar (gera gcal_event_id NOVO) — furo de borda cravado como
--   dívida no ADR (mitigação = alerta de estorno + job de reconciliação, bloco 2b/depois).
--
-- ISOLAMENTO:
--   - FK credit_id -> client_package_credits(id): movimento pertence a um crédito.
--   - INDEX(credit_id): reconstruir saldo de um crédito (SUM(delta)).
--   - INDEX(slot): escopo por clone.
--
-- Idempotente: CREATE TABLE / CREATE UNIQUE INDEX IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE. Nenhum NOT NULL/FK sobre dado existente.
--
-- ── ROLLBACK (manual; release separada; só com aprovação do Bruno) ──────────────────
--   BEGIN;
--     DROP TABLE IF EXISTS package_redemptions;
--   COMMIT;
--   → (CUIDADO: dropar o ledger apaga o histórico de consumo/estorno — exportar antes.)
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS package_redemptions (
  id             BIGSERIAL    PRIMARY KEY,
  credit_id      BIGINT       NOT NULL REFERENCES client_package_credits(id),
  slot           TEXT         NOT NULL,
  tenant_id      UUID         NOT NULL,
  gcal_event_id  TEXT         NOT NULL,                       -- liga ao evento; idempotência + estorno
  colaborador_id BIGINT,                                      -- qual colaborador atendeu (estab); NULL = casa
  servico_nome   VARCHAR(160),
  delta          SMALLINT     NOT NULL,                       -- -1 consumo | +1 estorno
  reason         VARCHAR(24)  NOT NULL DEFAULT 'redeem',      -- redeem|refund|adjust
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE package_redemptions IS
  'Ledger append-only imutável do saldo de pacotes (ADR 0025). FONTE DA VERDADE; '
  'sessoes_restantes é cache. UNIQUE(gcal_event_id,reason) = idempotência por evento. '
  'Escrita só no bloco 2b (dedução em inserir_agendamento).';

-- Idempotência por evento: mesmo evento nunca desconta 2x nem estorna 2x.
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemption_event_reason
  ON package_redemptions (gcal_event_id, reason);

-- Reconstrução de saldo de um crédito + escopo por clone.
CREATE INDEX IF NOT EXISTS ix_redemption_credit ON package_redemptions (credit_id);
CREATE INDEX IF NOT EXISTS ix_redemption_slot   ON package_redemptions (slot);

COMMIT;
