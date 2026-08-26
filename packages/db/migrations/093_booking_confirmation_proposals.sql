-- Migration 093: confirmação de agendamento server-first (ADR 0046).
-- Pseudonymous by design: não guarda telefone, nome, summary, texto ou cartão.
BEGIN;

CREATE TABLE IF NOT EXISTS booking_confirmation_proposals (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  slot TEXT NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  contact_hmac TEXT NOT NULL CHECK (char_length(contact_hmac) = 64),
  colaborador_id BIGINT,
  servico TEXT NOT NULL CHECK (char_length(btrim(servico)) BETWEEN 1 AND 120),
  inicio_at TIMESTAMPTZ NOT NULL,
  fim_at TIMESTAMPTZ NOT NULL CHECK (fim_at > inicio_at),
  timezone TEXT NOT NULL CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 80),
  usa_pacote BOOLEAN,
  event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirming', 'booked', 'expired', 'superseded', 'conflict', 'recovery_required')),
  expires_at TIMESTAMPTZ NOT NULL,
  card_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slot, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_confirmation_pending_contact
  ON booking_confirmation_proposals (tenant_id, slot, contact_hmac)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ix_booking_confirmation_lookup
  ON booking_confirmation_proposals (tenant_id, slot, contact_hmac, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_booking_confirmation_expiry
  ON booking_confirmation_proposals (status, expires_at)
  WHERE status IN ('pending', 'confirming');

COMMIT;
