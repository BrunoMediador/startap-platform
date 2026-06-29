-- Migration 068: flow_clones.timezone — fuso horário (IANA) do relógio da barbearia, por clone.
--
-- MOTIVO (bug provado em produção, Seven 7 / Mato Grosso):
--   O sistema crava 'America/Sao_Paulo' (UTC-3) pra TODOS os clones ao converter o "horário de
--   parede" da barbearia (o que o LLM/portal emite) em instante absoluto (UTC) gravado no GCal e
--   derivar o dia (data) do faturamento. A Seven 7 fica em Mato Grosso ('America/Cuiaba', UTC-4),
--   então TODO agendamento dela nasce 1h adiantado, e bookings noturnos vazam pro dia seguinte no
--   faturado/comissão. A correção é suportar fuso POR CLONE, com DEFAULT São Paulo.
--
-- POR QUE UMA COLUNA NOVA:
--   O fuso é uma propriedade durável da barbearia (onde ela fica), não inferível do dado. Mora em
--   flow_clones (a âncora do tenant), 1 linha por clone. O DEFAULT 'America/Sao_Paulo' carimba TODA
--   linha existente — todo clone que NÃO é a Seven 7 permanece byte-idêntico ao comportamento de hoje.
--
-- VALIDAÇÃO: a taxonomia IANA é validada NO APP (padrão das migrations 051 `area` / 052 `product_type`),
--   NÃO por CHECK no banco — assim a lista de fusos suportados evolve sem nova migration.
--
-- BACKFILL: IMPLÍCITO pelo DEFAULT (o ALTER carimba toda linha existente como 'America/Sao_Paulo').
--   NÃO há UPDATE de backfill aqui. Setar a Seven 7 para 'America/Cuiaba' é um passo MANUAL, gated,
--   feito pelo Bruno em produção (fora desta migration) — NÃO setamos dado de cliente aqui.
--
-- ISOLAMENTO / multi-tenancy: aditivo puro — não piora a dívida P0 de multi-tenancy (segue por
--   coluna `slot`). tenant_id NÃO é necessário (a âncora já é a própria flow_clones).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida; nada na mesma release.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9, nunca dropar coluna na
--    mesma release que a adiciona; só com aprovação explícita do Bruno) ───────────────────────
--   BEGIN;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS timezone;
--   COMMIT;
--   → a coluna some; o app volta a tratar tudo como 'America/Sao_Paulo' (default chumbado no código).
-- ───────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Fuso (IANA) do relógio da barbearia. DEFAULT 'America/Sao_Paulo' carimba toda linha existente
-- no próprio ALTER (backfill implícito) — sem UPDATE adicional, sem sobrescrever nada.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

COMMENT ON COLUMN flow_clones.timezone IS
  'IANA timezone do relógio da barbearia (ex: America/Sao_Paulo, America/Cuiaba). Default SP. Validado no app, não no banco.';

COMMIT;
