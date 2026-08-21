BEGIN;

CREATE INDEX IF NOT EXISTS ix_atendimentos_cliente_sem_retorno_agenda
  ON atendimentos (
    tenant_id,
    slot,
    cliente_telefone_canonico,
    COALESCE(fim_at, inicio_at) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL
    AND status <> 'cancelado'
    AND origem = 'agenda'
    AND cliente_telefone_canonico IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_atendimentos_cliente_sem_retorno_manual
  ON atendimentos (
    tenant_id,
    slot,
    cliente_telefone_canonico,
    data DESC,
    id DESC
  )
  WHERE deleted_at IS NULL
    AND status <> 'cancelado'
    AND origem = 'manual'
    AND cliente_telefone_canonico IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_atendimentos_colab_cliente_sem_retorno_agenda
  ON atendimentos (
    tenant_id,
    slot,
    colaborador_id,
    cliente_telefone_canonico,
    COALESCE(fim_at, inicio_at) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL
    AND status <> 'cancelado'
    AND origem = 'agenda'
    AND colaborador_id IS NOT NULL
    AND cliente_telefone_canonico IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_atendimentos_colab_cliente_sem_retorno_manual
  ON atendimentos (
    tenant_id,
    slot,
    colaborador_id,
    cliente_telefone_canonico,
    data DESC,
    id DESC
  )
  WHERE deleted_at IS NULL
    AND status <> 'cancelado'
    AND origem = 'manual'
    AND colaborador_id IS NOT NULL
    AND cliente_telefone_canonico IS NOT NULL;

COMMIT;
