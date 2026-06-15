-- Migration 053: clone_colaboradores — profissionais de um estabelecimento.
--
-- ADR 0023, Fase A (esboço da seção 4) + ADR 0024 (gcal_calendar_id por colaborador).
-- Tabela NOVA. Toda linha carrega slot (FK -> flow_clones) + tenant_id UUID desde o
-- nascimento (caminho para RLS futuro, ADR 0018). Estabelecimento é SEMPRE 'clone_'.
--
-- SEM BACKFILL: individual = 0 linhas aqui (a agenda do individual segue em
--   flow_clones.gcal_calendar_id, intocada). Nenhum pagante gera linha nesta tabela.
--   Cirilo e Samuel são individual -> não aparecem aqui de jeito nenhum.
--
-- ISOLAMENTO:
--   - FK slot -> flow_clones(slot) ON DELETE CASCADE: ao deletar o clone, seus
--     colaboradores somem junto (sem órfão). flow_clones.slot é UNIQUE (âncora).
--   - tenant_id NOT NULL: carimbado na criação do colaborador (resolvido do clone).
--     Pré-requisito atendido: flow_clones.tenant_id existe (migrations 045/048).
--   - UNIQUE(slot, lower(nome)): impede dois homônimos no mesmo estabelecimento —
--     pré-requisito do roteamento por nome do bot ser determinístico (ADR 0023 §4,
--     critério de aceite 3 do teste adversarial de homônimos).
--   - INDEX(slot) e INDEX(tenant_id): escopo de query por clone e por tenant.
--
-- gcal_status: pending|active|invalid|disabled (validado no app, sem CHECK aqui —
--   mesmo padrão de product_type/area). Agenda criada SOB DEMANDA (ADR 0024 §3):
--   gcal_calendar_id nasce NULL e é preenchido quando calendars.insert roda no
--   cadastro do colaborador (próximo incremento — não neste PR).
--
-- Idempotente: CREATE TABLE / CREATE INDEX IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com
--    aprovação explícita do Bruno; individual nunca teve linha aqui) ───────────────
--   BEGIN;
--     DROP TABLE IF EXISTS clone_colaboradores;
--   COMMIT;
--   → a tabela some. Nenhum pagante (individual) é afetado — nunca teve colaborador.
-- ───────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS clone_colaboradores (
  id                BIGSERIAL    PRIMARY KEY,
  slot              TEXT         NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  tenant_id         UUID         NOT NULL,
  nome              VARCHAR(160) NOT NULL,
  gcal_calendar_id  TEXT,                                       -- agenda secundaria deste colaborador (ADR 0024); NULL ate criar sob demanda
  gcal_status       VARCHAR(16)  NOT NULL DEFAULT 'pending',    -- pending|active|invalid|disabled (validado no app)
  ativo             BOOLEAN      NOT NULL DEFAULT TRUE,
  ordem             SMALLINT     NOT NULL DEFAULT 0,            -- desempate "primeiro disponivel" (Fase B)
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE clone_colaboradores IS
  'Profissionais de um estabelecimento (ADR 0023). Individual = 0 linhas. Cada linha carrega slot + tenant_id (caminho RLS).';

-- Impede homonimos no mesmo estabelecimento (roteamento por nome deterministico).
CREATE UNIQUE INDEX IF NOT EXISTS uq_colab_slot_nome ON clone_colaboradores (slot, lower(nome));

-- Escopo de query por clone e por tenant.
CREATE INDEX IF NOT EXISTS ix_colab_slot   ON clone_colaboradores (slot);
CREATE INDEX IF NOT EXISTS ix_colab_tenant ON clone_colaboradores (tenant_id);

COMMIT;
