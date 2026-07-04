-- Migration 070: flow_clones.prompt_custom — protege a persona CUSTOM do clobber (SCRUM-59).
--
-- MOTIVO (bug provado no teste ao vivo do piloto Meduzza):
--   updateClone (packages/db/src/queries/flow-clones.ts) RE-RENDERIZA o bot_prompt a partir do
--   template da MATRIZ em QUALQUER mudança de personalizacao. O PUT /portal/perfil grava
--   personalizacao — INCLUSIVE o toggle `agenda_automatica` da seção nova do modo atendente —
--   então salvar o perfil APAGARIA a persona custom do piloto (6141 chars escritos à mão → 1450
--   do template genérico). O gestão (PATCH /api/clones) já NÃO re-renderiza desde maio; faltava o
--   mesmo guard no caminho do portal.
--
-- FIX (opção B — espelha a decisão do gestão de maio; redesign de prompt-override fica pra depois
--   se precisar): coluna booleana `prompt_custom`. updateClone só re-renderiza quando FALSE.
--
-- POR QUE UMA COLUNA NOVA:
--   "este clone tem prompt escrito à mão, não derive do template" é uma propriedade durável do
--   clone, não inferível do dado. Mora em flow_clones (âncora do tenant), 1 linha por clone. O
--   DEFAULT false carimba TODA linha existente — Cirilo/Samuel (que usam o render default) seguem
--   BYTE-A-BYTE (re-renderizam como hoje).
--
-- BACKFILL: o DEFAULT false cobre todo mundo. O ÚNICO UPDATE aqui carimba o PILOTO Meduzza como
--   custom, pra o deploy proteger a persona dele SEM passo manual (o prompt custom dele já está no
--   banco; só falta o flag que impede o updateClone de sobrescrevê-lo no próximo save de perfil).
--   Slot parametrizado no literal (não é dado sensível; é o id do clone do piloto).
--
-- ISOLAMENTO / multi-tenancy: aditivo puro — não piora a dívida P0 (segue por coluna `slot`).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE idempotente (re-rodar = no-op).
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida na mesma release.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9, nunca dropar coluna na
--    mesma release que a adiciona; só com aprovação explícita do Bruno) ───────────────────────
--   BEGIN;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS prompt_custom;
--   COMMIT;
--   → a coluna some; o updateClone volta a re-renderizar em toda mudança de personalizacao (default
--     chumbado = false no código). ⚠️ isso reexpõe o bug de clobber pro piloto — não rodar sem plano.
-- ───────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- "Este clone tem prompt escrito à mão (não derivar do template da matriz)". DEFAULT false
-- carimba toda linha existente no próprio ALTER (backfill implícito) — clones com render default
-- (Cirilo/Samuel) continuam re-renderizando como hoje.
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS prompt_custom BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN flow_clones.prompt_custom IS
  'true = bot_prompt escrito à mão; updateClone NÃO re-renderiza do template ao mudar personalizacao (SCRUM-59). Default false = render default (comportamento de hoje).';

-- Carimba o PILOTO Meduzza como custom (protege a persona de 6141 chars do re-render no save do
-- perfil). Idempotente. Se o slot não existir neste ambiente, o UPDATE afeta 0 linhas (no-op).
UPDATE flow_clones SET prompt_custom = true WHERE slot = 'clone_meduzza_barbearia_q23psc';

COMMIT;
