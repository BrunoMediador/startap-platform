BEGIN;

-- Missão 037: trilha mínima sem corpo de mensagem nem telefone. A guarda é
-- persistente e serializa o cooldown entre instâncias do portal-api.
CREATE TABLE IF NOT EXISTS crm_whatsapp_manual_send_guards (
  slot TEXT NOT NULL REFERENCES flow_clones(slot),
  tenant_id UUID NOT NULL,
  cliente_id UUID NOT NULL REFERENCES clientes(id),
  operator_user_id BIGINT NOT NULL REFERENCES portal_users(id),
  cooldown_until TIMESTAMPTZ NOT NULL,
  last_send_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slot, tenant_id, cliente_id, operator_user_id)
);

CREATE TABLE IF NOT EXISTS crm_whatsapp_manual_send_audit (
  id UUID PRIMARY KEY,
  slot TEXT NOT NULL REFERENCES flow_clones(slot),
  tenant_id UUID NOT NULL,
  cliente_id UUID NOT NULL REFERENCES clientes(id),
  operator_user_id BIGINT NOT NULL REFERENCES portal_users(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('claimed', 'sent', 'failed')),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT crm_whatsapp_manual_audit_failure_chk CHECK (
    (outcome = 'failed' AND failure_code IS NOT NULL)
    OR (outcome <> 'failed' AND failure_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_crm_whatsapp_manual_audit_scope_created
  ON crm_whatsapp_manual_send_audit (slot, tenant_id, cliente_id, created_at DESC);

COMMIT;
