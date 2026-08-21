BEGIN;

CREATE INDEX IF NOT EXISTS ix_clientes_aniversario_mmdd
  ON clientes (slot, tenant_id, aniversario_mmdd, id)
  WHERE aniversario_mmdd IS NOT NULL;

COMMIT;
