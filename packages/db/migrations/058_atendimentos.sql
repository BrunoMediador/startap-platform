-- Migration 058: atendimentos — FONTE DA VERDADE do financeiro do NEGÓCIO do cliente
-- (faturamento + comissão). ADR 0026.
--
-- O atendimento é o registro de que um serviço FOI PRESTADO e gerou (ou não) receita,
-- com valor, profissional e forma de pagamento. Disso nascem os relatórios de
-- FATURAMENTO e COMISSÃO por profissional. Google Calendar segue dono do HORÁRIO
-- (ADR 0006); atendimentos é dono do DINHEIRO. Ligam-se por gcal_event_id NULLABLE
-- (NULL = walk-in registrado direto no painel, sem agenda).
--
-- ⚠️ SEPARAÇÃO DURA DE DOMÍNIOS (ADR 0026 §2): client_billing/AbacatePay é a MENSALIDADE
-- B2B que o cliente paga PRA NÓS. atendimentos é o faturamento do negócio DELE. NUNCA
-- se misturam — tabelas, telas e relatórios separados. Um relatório nunca soma coluna
-- da outra.
--
-- Tabela NOVA. Toda linha carrega slot (FK -> flow_clones) + tenant_id UUID desde o
-- nascimento (caminho para RLS futuro, ADR 0018). MESMO padrão de 053_clone_colaboradores
-- e 056_package_redemptions.
--
-- DOIS CENÁRIOS (ADR 0026 §Decisão):
--   * SOLO (individual, ex: Cirilo/Samuel): colaborador_id NULL -> só FATURAMENTO,
--     sem split de comissão (comissao_cents=0; o dono fica com tudo).
--   * EMPRESA (estabelecimento, ex: barber_dragon): colaborador_id = profissional ->
--     FATURAMENTO + COMISSÃO (% snapshot de clone_colaboradores.comissao_pct).
--
-- COMISSÃO = % fixo por profissional sobre o valor BRUTO (líquido de desconto),
-- congelado (snapshot de comissao_pct + comissao_cents) NA LINHA do atendimento —
-- mudar o % do profissional amanhã NÃO reescreve o histórico.
--
-- PACOTE (ADR 0026 §risco 1): atendimento pago com crédito de pacote
-- (forma_pagamento='pacote') lança valor_cents=0 (a receita já entrou na venda do
-- pacote; não contar 2×). Regra aplicada no app (POST /portal/atendimentos).
--
-- VALORES sempre em centavos inteiros (consistente com *_cents do billing; nunca float).
--
-- ISOLAMENTO:
--   - FK slot -> flow_clones(slot) ON DELETE CASCADE: ao deletar o clone, seus
--     atendimentos somem junto (sem órfão). flow_clones.slot é UNIQUE (âncora).
--   - FK colaborador_id -> clone_colaboradores(id) ON DELETE SET NULL: remover um
--     profissional NÃO apaga o histórico financeiro dele (o atendimento vira "sem
--     profissional"; o snapshot de comissão já está congelado na linha).
--   - tenant_id NOT NULL: carimbado na criação (resolvido do clone, ADR 0018).
--   - INDEX(slot, tenant_id, data): relatório por período escopado por tenant.
--   - INDEX(colaborador_id): comissão por profissional.
--
-- status/forma_pagamento: validados no APP (sem CHECK aqui — mesmo padrão de
--   product_type/area/gcal_status). status: agendado|realizado|cancelado.
-- gcal_event_id SEM UNIQUE (um evento pode em tese gerar 0..1 atendimento; a
--   unicidade fica no app pra não travar correção manual — ADR 0026 §Modelo).
--
-- ADITIVA: só CRIA tabela + coluna nova. SEM backfill, SEM tocar linha existente.
--   Nenhum pagante afetado. Rotas atrás de flag ATENDIMENTOS_ENABLED (OFF default).
--
-- Idempotente: CREATE TABLE / CREATE INDEX / ADD COLUMN IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE sobre dado existente.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com
--    aprovação explícita do Bruno) ──────────────────────────────────────────────────
--   BEGIN;
--     ALTER TABLE clone_colaboradores DROP COLUMN IF EXISTS comissao_pct;
--     DROP TABLE IF EXISTS atendimentos;   -- CUIDADO: apaga o histórico financeiro
--   COMMIT;                                 --          do negócio do cliente — exportar antes.
--   → a tabela some e a coluna volta. Flag OFF = produção idêntica; nenhum pagante afetado.
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Coluna de comissão por profissional (snapshot é congelado no atendimento; este é o
-- valor CORRENTE editável no cadastro). Aditiva; default 0 = sem comissão (SOLO ou
-- profissional sem regra). Individual = 0 linhas em clone_colaboradores hoje (053).
ALTER TABLE clone_colaboradores
  ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS atendimentos (
  id               BIGSERIAL    PRIMARY KEY,
  slot             TEXT         NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  tenant_id        UUID         NOT NULL,                          -- carimbado na criação (ADR 0018)
  gcal_event_id    TEXT,                                          -- liga ao horário; NULL = walk-in sem agenda
  cliente_nome     VARCHAR(160),                                  -- texto livre v1 (ref a tabela de clientes = futuro)
  cliente_contato  VARCHAR(64),                                   -- LGPD: não logar em claro
  servico_nome     VARCHAR(160),                                  -- snapshot do nome do serviço
  valor_cents      INTEGER      NOT NULL DEFAULT 0,               -- centavos inteiros (nunca float)
  desconto_cents   INTEGER      NOT NULL DEFAULT 0,
  forma_pagamento  VARCHAR(24),                                   -- dinheiro|pix|credito|debito|pacote|... (validado no app)
  colaborador_id   BIGINT       REFERENCES clone_colaboradores(id) ON DELETE SET NULL, -- NULL = SOLO (sem profissional)
  comissao_pct     NUMERIC(5,2),                                  -- snapshot do % no ato (NULL = sem comissão)
  comissao_cents   INTEGER      NOT NULL DEFAULT 0,               -- snapshot do valor calculado
  status           VARCHAR(16)  NOT NULL DEFAULT 'realizado',     -- agendado|realizado|cancelado (validado no app)
  data             DATE         NOT NULL DEFAULT (now()::date),   -- dia do atendimento (base dos relatórios)
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE atendimentos IS
  'FONTE DA VERDADE do financeiro do NEGÓCIO do cliente (faturamento + comissão), ADR 0026. '
  'GCal = dono do horário; aqui = dono do dinheiro (ligam por gcal_event_id NULLABLE). '
  'NÃO se mistura com client_billing (mensalidade B2B nossa). slot+tenant_id em toda linha (RLS).';

-- Relatório por período escopado por tenant (faturamento de/ate).
CREATE INDEX IF NOT EXISTS ix_atend_slot_tenant_data ON atendimentos (slot, tenant_id, data);
-- Escopo por tenant (defesa em profundidade RLS).
CREATE INDEX IF NOT EXISTS ix_atend_tenant            ON atendimentos (tenant_id);
-- Comissão por profissional.
CREATE INDEX IF NOT EXISTS ix_atend_colaborador       ON atendimentos (colaborador_id);

COMMIT;
