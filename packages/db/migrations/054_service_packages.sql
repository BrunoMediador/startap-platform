-- Migration 054: service_packages — TEMPLATE de pacote definido pelo dono.
--
-- ADR 0025 (pacotes de serviço: saldo por sessões, ledger imutável, FORA do MRR).
-- BLOCO 2a (modelo + consulta read-only). A DEDUÇÃO é o bloco 2b (NÃO neste PR).
--
-- Tabela NOVA. Toda linha carrega slot (FK -> flow_clones) + tenant_id UUID desde o
-- nascimento (caminho para RLS futuro, ADR 0018). Vale para individual E
-- estabelecimento — Cirilo/Samuel (individual) já vendem pacote; colaborador_id NULL
-- = pacote da casa inteira (caso individual), preenchido = só com aquele colaborador.
--
-- SEM BACKFILL: zero linha nasce nesta migration. Nenhum pagante gera linha aqui até
--   o dono DEFINIR um pacote (CRUD é bloco 2b/depois) E a flag PACOTES_ENABLED ligar.
--   Com a flag OFF, esta tabela nunca é lida no caminho quente -> Cirilo/Samuel
--   byte-a-byte.
--
-- FISCAL (§5 do ADR): preco_cents é INFORMATIVO — o dinheiro do pacote é caixa do
--   barbeiro (venda do cliente pro cliente DELE). NÃO toca AbacatePay / client_billing
--   / billing_charges / MRR. Nós só rastreamos o SALDO.
--
-- VALIDADE (decisão do Bruno): pacote suporta OS DOIS modelos —
--   * validade_dias       = "vale X dias a partir da compra" (data_expiracao derivada);
--   * data_validade_fixa  = "vale até esta data" (fim de promoção, p.ex.).
--   Exatamente UM dos dois é usado por template (validado no app, não por CHECK rígido,
--   p/ não bloquear ajustes futuros — mesmo padrão de product_type/area/gcal_status).
--
-- ISOLAMENTO:
--   - FK slot -> flow_clones(slot) ON DELETE CASCADE: ao deletar o clone, seus
--     templates de pacote somem junto (sem órfão). flow_clones.slot é UNIQUE (âncora).
--   - tenant_id NOT NULL: carimbado na criação (resolvido do clone).
--   - FK colaborador_id -> clone_colaboradores(id) ON DELETE SET NULL: se o colaborador
--     sai, o pacote vira "da casa" (NULL) em vez de quebrar/órfanar.
--   - INDEX(slot) e INDEX(slot, ativo): escopo de listagem por clone (templates ativos).
--
-- Idempotente: CREATE TABLE / CREATE INDEX IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE. Nenhum NOT NULL/FK sobre dado existente.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação
--    explícita do Bruno; nenhum pagante depende desta tabela) ────────────────────────
--   BEGIN;
--     DROP TABLE IF EXISTS service_packages CASCADE;  -- (cascade some redenções/créditos)
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS service_packages (
  id                 BIGSERIAL    PRIMARY KEY,
  slot               TEXT         NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  tenant_id          UUID         NOT NULL,
  nome               VARCHAR(160) NOT NULL,
  descricao          TEXT,
  servicos_cobertos  JSONB        NOT NULL DEFAULT '[]',  -- array de servico_nome; [] = nada cobre
  total_sessoes      SMALLINT     NOT NULL,
  validade_dias      SMALLINT,                            -- "vale X dias" (NULL se usa data fixa)
  data_validade_fixa DATE,                                -- "vale até esta data" (NULL se usa dias)
  preco_cents        INTEGER,                             -- INFORMATIVO (caixa do barbeiro), NÃO toca billing
  colaborador_id     BIGINT       REFERENCES clone_colaboradores(id) ON DELETE SET NULL, -- NULL = casa
  ativo              BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE service_packages IS
  'Template de pacote (ADR 0025). preco_cents INFORMATIVO (caixa do barbeiro, fora do MRR). '
  'Vale individual E estabelecimento. Validade: validade_dias OU data_validade_fixa (um dos dois).';

-- Escopo de listagem por clone; índice parcial p/ "templates ativos do slot" (caminho quente).
CREATE INDEX IF NOT EXISTS ix_service_packages_slot ON service_packages (slot);
CREATE INDEX IF NOT EXISTS ix_service_packages_slot_ativo
  ON service_packages (slot) WHERE ativo = TRUE;

COMMIT;
