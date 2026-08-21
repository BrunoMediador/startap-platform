BEGIN;

CREATE TABLE IF NOT EXISTS clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  slot TEXT NOT NULL REFERENCES flow_clones(slot),
  telefone_canonico TEXT NOT NULL,
  telefone_raw TEXT NOT NULL,
  nome TEXT,
  aniversario_mmdd TEXT,
  cidade TEXT,
  nota_interna TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_clientes_tenant_phone UNIQUE (tenant_id, telefone_canonico),
  CONSTRAINT clientes_telefone_canonico_chk CHECK (
    telefone_canonico ~ '^[0-9]{10,15}$'
  ),
  CONSTRAINT clientes_telefone_raw_chk CHECK (
    regexp_replace(telefone_raw, '[^0-9]', '', 'g') ~ '^[0-9]{8,15}$'
  ),
  CONSTRAINT clientes_aniversario_mmdd_chk CHECK (
    aniversario_mmdd IS NULL OR aniversario_mmdd ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
  ),
  CONSTRAINT clientes_cidade_chk CHECK (
    cidade IS NULL OR char_length(cidade) <= 80
  ),
  CONSTRAINT clientes_nota_interna_chk CHECK (
    nota_interna IS NULL OR char_length(nota_interna) <= 2000
  )
);

CREATE INDEX IF NOT EXISTS ix_clientes_slot_tenant_updated
  ON clientes (slot, tenant_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ix_clientes_tenant_nome
  ON clientes (tenant_id, lower(nome));

CREATE INDEX IF NOT EXISTS ix_clientes_tenant_cidade
  ON clientes (tenant_id, lower(cidade));

ALTER TABLE atendimentos
  ADD COLUMN IF NOT EXISTS cliente_telefone_canonico TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'atendimentos_cliente_telefone_canonico_chk'
  ) THEN
    ALTER TABLE atendimentos
      ADD CONSTRAINT atendimentos_cliente_telefone_canonico_chk
      CHECK (
        cliente_telefone_canonico IS NULL
        OR cliente_telefone_canonico ~ '^[0-9]{10,15}$'
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_atendimentos_cliente_hist
  ON atendimentos (tenant_id, slot, cliente_telefone_canonico, data DESC, id DESC)
  WHERE deleted_at IS NULL AND cliente_telefone_canonico IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_atendimentos_colab_cliente_hist
  ON atendimentos (tenant_id, slot, colaborador_id, cliente_telefone_canonico, data DESC, id DESC)
  WHERE deleted_at IS NULL
    AND colaborador_id IS NOT NULL
    AND cliente_telefone_canonico IS NOT NULL;

COMMIT;
