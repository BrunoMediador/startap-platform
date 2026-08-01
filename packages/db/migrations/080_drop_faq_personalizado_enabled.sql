-- Migration 080: DROP flow_clones.faq_personalizado_enabled — faxina final do FAQ
-- personalizado (SCRUM-65 / PR #552-#555, 01/08).
--
-- CONTEXTO: o campo "Perguntas frequentes" saiu do portal em 01/08 (PR #552 migrou o
-- conteúdo existente para dentro de `bot_prompt`, #555 trocou o builder pra aceitar FAQ
-- na persona via IA, #554 removeu a UI). O plano combinado deixava o backend (rota,
-- schema, gate, coluna) vivo como dívida técnica temporária. Esta migration é a faxina
-- completa que o Bruno pediu: elimina o backend morto, inclusive a coluna.
--
-- PRÉ-CONDIÇÃO MEDIDA EM PROD (01/08, PM): `SELECT count(*) FILTER (WHERE personalizacao ?
-- 'faq_personalizado') FROM flow_clones` = 0 de 6. Idem `faq_personalizado_enabled` = 0.
-- Os 2 clones que tinham FAQ (dragon, Ingrid) já têm o bloco [PERGUNTAS FREQUENTES...]
-- materializado DENTRO do `bot_prompt` deles (migração já rodada, script
-- scripts/migrate-faq-para-prompt.ts, removido nesta mesma PR por já ter cumprido a função).
-- Migração 100% concluída — dropar a coluna não perde dado de cliente algum.
--
-- NÃO TOCA: `modo_atendente_enabled` / `billing_from_agenda_enabled` (mesma migration 072
-- que criou as 3 colunas — só a do FAQ sai aqui, as outras 2 seguem EM USO). O bloco
-- [PERGUNTAS FREQUENTES...] que já está DENTRO do `bot_prompt` do dragon/Ingrid é conteúdo
-- do cliente agora — intocável, não vive nesta coluna.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9) ───────────────────
--   BEGIN;
--     ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS faq_personalizado_enabled
--       BOOLEAN NOT NULL DEFAULT false;
--   COMMIT;
--   → a coluna volta com DEFAULT false pra toda linha (idêntico ao estado pré-migration,
--     já que a pré-condição comprovou 0 clones com a coluna true). O código que a lia foi
--     removido nesta mesma PR — reverter a coluna sozinha não religa a feature; seria
--     necessário reverter também o código (fora do escopo deste rollback de dado).
-- ─────────────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE flow_clones
  DROP COLUMN IF EXISTS faq_personalizado_enabled;

COMMIT;
