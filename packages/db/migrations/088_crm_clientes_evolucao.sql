BEGIN;

-- Nome de apresentação é uma correção local do dono. O nome de origem continua em
-- clientes.nome e nenhum snapshot/histórico é reescrito.
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS nome_personalizado TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clientes_nome_personalizado_chk'
  ) THEN
    ALTER TABLE clientes
      ADD CONSTRAINT clientes_nome_personalizado_chk
      CHECK (nome_personalizado IS NULL OR char_length(btrim(nome_personalizado)) BETWEEN 1 AND 120);
  END IF;
END $$;

-- Consultas sempre prefixam slot+tenant. O índice cobre a ordenação estável sem
-- depender de um índice global de PII; pg_trgm não é introduzido nesta fatia.
CREATE INDEX IF NOT EXISTS ix_clientes_crm_slot_tenant_nome_personalizado
  ON clientes (slot, tenant_id, lower(nome_personalizado), id)
  WHERE nome_personalizado IS NOT NULL;

-- Os índices parciais de atendimento elegível já existem na migration 085.
-- Não criar uma variante invertendo slot/tenant: ambas as colunas são igualdade
-- no ranking e na tabela, então seria redundante e tornaria o plano instável.

COMMIT;
