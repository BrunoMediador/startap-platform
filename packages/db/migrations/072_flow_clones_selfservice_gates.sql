-- Migration 072: flow_clones.{modo_atendente,faq_personalizado,billing_from_agenda}_enabled —
-- move os 3 gates por-clone de env-CSV para CONFIGURAÇÃO POR-CLONE (coluna). ADR 0030, Onda 2.
--
-- MOTIVO (produtização self-service, SCRUM-68 / ADR 0030 D1):
--   Hoje 3 features são gateadas por env-CSV por-slot (recreate manual pra ligar um clone):
--     MODO_ATENDENTE_SLOTS      -> packages/core/src/modo-atendente-gate.ts
--     ATEND_FROM_AGENDA_SLOTS   -> packages/core/src/atend-from-agenda-gate.ts
--     FAQ_PERSONALIZADO_SLOTS   -> packages/core/src/faq-personalizado-gate.ts
--   Pra o produto ser contratável pelo signup sem env manual, a decisão vira COLUNA por-clone.
--   O env PERMANECE como kill-switch/override GLOBAL — a camada de resolução computa a UNIÃO:
--       efetivo(feature, slot) = isEnabledFromCsv(slot, envCsv)  OR  colunaPorClone(slot)
--   Enquanto o env cobrir o slot (ou for '*'), a UNIÃO o mantém ON INDEPENDENTE da coluna
--   -> byte-identidade garantida pra quem já roda; a coluna só ADICIONA capacidade (ligar
--   por-clone sem env) e é o botão de pânico continua sendo o env (sem deploy).
--
-- POR QUE COLUNAS TIPADAS (e não JSONB) — ADR 0030 D1/Alt.2:
--   Sem ORM na casa; colunas BOOLEAN NOT NULL DEFAULT false dão validação forte no schema SQL,
--   são queryáveis/indexáveis e o DEFAULT false carimba TODA linha existente. Ninguém regride:
--   a camada de resolução faz OR do env, então mesmo lendo a coluna nada muda até o backfill,
--   e o backfill só ESPELHA o que o env já liga hoje.
--
-- BACKFILL (espelha o estado atual dos CSVs de produção pra ficar byte-idêntico — mesmo padrão
--   da migration 070, que carimbou o slot do piloto por literal exato, idempotente/no-op se o
--   slot não existir no ambiente):
--     modo_atendente_enabled     = true  no slot da Meduzza (MODO_ATENDENTE_SLOTS atual).
--     billing_from_agenda_enabled= true  nos slots do ATEND_FROM_AGENDA (dragon, cirilo, samuel).
--     faq_personalizado_enabled  = false pra todos (o env FAQ_PERSONALIZADO_SLOTS='*' já cobre
--                                  TODOS via a UNIÃO -> nasce false sem regredir ninguém).
--   ⚠️ A byte-identidade NÃO depende da exatidão do backfill: o env segue setado em produção e
--   vence na UNIÃO. O backfill é FORWARD-COMPAT (preserva o estado se o env for enxugado depois).
--   Slugs = literais exatos derivados do repo (070 = Meduzza; ADR 0018 = Samuel; testes/CLAUDE.md
--   = Cirilo/Dragon). Se um slug divergir num ambiente, o env ainda cobre (sem regressão) e um
--   UPDATE de correção da coluna é trivial.
--
-- ISOLAMENTO / multi-tenancy: aditivo puro — não piora a dívida P0 (segue por coluna `slot`).
--   Colunas moram em flow_clones (âncora do tenant), 1 linha por clone. tenant_id não necessário.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE ... WHERE slug literal (no-op se ausente / re-run).
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida na mesma release.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9: nunca dropar coluna na
--    mesma release que a adiciona; só com aprovação explícita do Bruno) ────────────────────────
--   BEGIN;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS modo_atendente_enabled;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS faq_personalizado_enabled;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS billing_from_agenda_enabled;
--   COMMIT;
--   → as colunas somem; a resolução volta a depender SÓ do env-CSV (default chumbado no código:
--     normalizeCloneRow devolve false quando a coluna não vem no SELECT -> OR do env inalterado).
--     Reversão é SEGURA porque o env segue sendo a fonte que liga os clones vivos hoje.
-- ───────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- MODO ATENDENTE (SCRUM-59). DEFAULT false carimba toda linha -> só o env liga hoje.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS modo_atendente_enabled BOOLEAN NOT NULL DEFAULT false;

-- FAQ PERSONALIZADO (SCRUM-65). DEFAULT false; o env '*' cobre todos via UNIÃO.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS faq_personalizado_enabled BOOLEAN NOT NULL DEFAULT false;

-- BILLING DERIVADO DA AGENDA (ADR 0027). DEFAULT false; env ATEND_FROM_AGENDA_SLOTS liga hoje.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS billing_from_agenda_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN flow_clones.modo_atendente_enabled IS
  'true = modo atendente ligado por-clone (ADR 0030 D1). efetivo = env MODO_ATENDENTE_SLOTS OR esta coluna. Default false.';
COMMENT ON COLUMN flow_clones.faq_personalizado_enabled IS
  'true = FAQ personalizado ligado por-clone (ADR 0030 D1). efetivo = env FAQ_PERSONALIZADO_SLOTS OR esta coluna. Default false (env "*" cobre todos hoje).';
COMMENT ON COLUMN flow_clones.billing_from_agenda_enabled IS
  'true = billing derivado da agenda ligado por-clone (ADR 0027/0030 D1). efetivo = env ATEND_FROM_AGENDA_SLOTS OR esta coluna. Default false.';

-- ── BACKFILL: espelha o estado dos CSVs de produção (idempotente; no-op se o slug não existir) ──

-- MODO_ATENDENTE_SLOTS atual = Meduzza (piloto). Mesmo slug literal da migration 070.
UPDATE flow_clones SET modo_atendente_enabled = true
  WHERE slot = 'clone_meduzza_barbearia_q23psc';

-- ATEND_FROM_AGENDA_SLOTS atual = dragon, cirilo, samuel (CLAUDE.md/auditoria 27/06 + ADR 0018).
UPDATE flow_clones SET billing_from_agenda_enabled = true
  WHERE slot IN (
    'clone_barber_dragon_caly8b',      -- dragon (estabelecimento de teste, cliente real)
    'clone_cirilobarbearia_c8w2f0',    -- Cirilo (pagante)
    'clone_barbearia_samuel_uefpqc'    -- Samuel (pagante)
  );

-- FAQ_PERSONALIZADO_SLOTS='*' -> coberto pela UNIÃO do env; coluna nasce false (sem backfill).

COMMIT;
