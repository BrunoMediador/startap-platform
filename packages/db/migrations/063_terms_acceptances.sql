-- Migration 063: terms_acceptances — PROVA DE ACEITE dos Termos de Uso + Política de
-- Privacidade no cadastro self-service (SCRUM-1 / LGPD art. 7, 8 e 9: consentimento
-- demonstrável). Cada linha é o registro append-only de que UM usuário aceitou UMA
-- versão dos termos, com data/IP/user-agent pra trilha de auditoria.
--
-- POR QUÊ: hoje o /cadastro só mostra a frase passiva "ao continuar você aceita…",
-- SEM checkbox e SEM persistência. Não há como provar o aceite (exigência LGPD).
-- Esta tabela é a fonte da verdade desse aceite.
--
-- MODELO (append-only, NUNCA UPDATE/DELETE em linha existente — cada aceite é um fato
-- imutável; reaceite = nova linha):
--   - slot            : tenant dono do aceite (FK -> flow_clones, ON DELETE CASCADE:
--                       deletar o clone leva junto a prova — não há aceite sem conta).
--   - tenant_id       : carimbo do tenant (caminho RLS futuro, ADR 0018). NULLABLE de
--                       propósito: resolveTenantId é fail-safe (pode devolver NULL sem
--                       derrubar a escrita); aceite NUNCA falha por resolução de tenant.
--   - portal_user_id  : usuário que aceitou (FK -> portal_users, ON DELETE SET NULL:
--                       churn do user NÃO apaga a prova; o slot ainda a ancora).
--   - terms_version   : versão dos Termos aceita (ex.: 'v1') — SERVER-AUTHORITATIVE,
--                       nunca vem do cliente. Bump quando o texto legal mudar.
--   - privacy_version : versão da Política de Privacidade aceita (ex.: 'v1').
--   - ip              : IP de origem (LGPD: dado pessoal — NUNCA logar em claro; fica só
--                       aqui pra prova). TEXT (não INET) tolera proxy/lista/IPv6 cru.
--   - user_agent      : navegador/dispositivo no ato (trilha de auditoria).
--   - accepted_at     : instante do aceite (default now()).
--
-- ISOLAMENTO (regra de ouro 5): toda linha carrega slot; tenant_id segue o caminho RLS.
--   INDEX(slot) e INDEX(slot, terms_version, privacy_version) servem a auditoria por
--   tenant/versão. Sem UNIQUE: reaceite (nova versão) é uma nova linha, não um upsert.
--
-- ADITIVA: só CRIA tabela nova. SEM backfill, SEM tocar linha/coluna existente.
--   Nenhum cliente atual afetado (quem já tem conta não passa pelo signup de novo).
--
-- Idempotente: CREATE TABLE / CREATE INDEX IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE. Reversível em release separada (regra 9).
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com
--    aprovação explícita do Bruno) ──────────────────────────────────────────────────
--   BEGIN;
--     DROP TABLE IF EXISTS terms_acceptances;  -- CUIDADO: apaga a prova de aceite —
--   COMMIT;                                     --          exportar antes se necessário.
--   → a tabela some; o resto da produção fica idêntico. Nenhum dado de cliente afetado.
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id              BIGSERIAL    PRIMARY KEY,
  slot            TEXT         NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  tenant_id       UUID,                                            -- carimbo RLS (fail-safe NULL, ADR 0018)
  portal_user_id  BIGINT       REFERENCES portal_users(id) ON DELETE SET NULL, -- quem aceitou
  terms_version   TEXT         NOT NULL,                           -- ex.: 'v1' (server-authoritative)
  privacy_version TEXT         NOT NULL,                           -- ex.: 'v1' (server-authoritative)
  ip              TEXT,                                            -- LGPD: dado pessoal, não logar em claro
  user_agent      TEXT,                                            -- trilha de auditoria
  accepted_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE terms_acceptances IS
  'PROVA DE ACEITE (append-only) dos Termos de Uso + Política de Privacidade no signup '
  '(SCRUM-1 / LGPD consentimento demonstrável). slot ancora o tenant; versões são '
  'server-authoritative. NUNCA UPDATE/DELETE: reaceite = nova linha.';

-- Auditoria por tenant.
CREATE INDEX IF NOT EXISTS ix_terms_accept_slot
  ON terms_acceptances (slot);
-- Auditoria por versão aceita (quem aceitou a vN dos termos/privacidade).
CREATE INDEX IF NOT EXISTS ix_terms_accept_slot_versions
  ON terms_acceptances (slot, terms_version, privacy_version);

COMMIT;
