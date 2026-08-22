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

-- As duas fontes elegíveis são separadas por origem para o planejador usar os
-- índices parciais tanto no ranking quanto nos filtros da tabela principal.
CREATE INDEX IF NOT EXISTS ix_atendimentos_cliente_crm_lista_agenda
  ON atendimentos (slot, tenant_id, cliente_telefone_canonico, COALESCE(fim_at, inicio_at) DESC, id DESC)
  WHERE deleted_at IS NULL
    AND status <> 'cancelado'
    AND origem = 'agenda'
    AND cliente_telefone_canonico IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_atendimentos_cliente_crm_lista_manual
  ON atendimentos (slot, tenant_id, cliente_telefone_canonico, data DESC, id DESC)
  WHERE deleted_at IS NULL
    AND status <> 'cancelado'
    AND origem = 'manual'
    AND cliente_telefone_canonico IS NOT NULL;

COMMIT;
