-- Migration 057: servicos por colaborador em clone_colaboradores (CRUD da gestao).
--
-- ADR 0023 (estabelecimento). A migration 053 criou clone_colaboradores SEM uma coluna
-- para "quais servicos este colaborador faz". O bot (Fase A, #319) roteia por NOME do
-- colaborador e nao precisa dessa lista AINDA (a juncao colaborador x servico e Fase B).
-- Mas o CRUD da gestao (Bloco 3) precisa PERSISTIR a selecao que o dono faz no painel,
-- entao adicionamos UMA coluna aditiva, nullable, default '[]'.
--
-- Coluna:
--   servicos JSONB NOT NULL DEFAULT '[]'  -- array de servico_nome (os mesmos nomes de
--     flow_clones.servicos[].nome). [] = "faz todos / nao especificado" (decisao de
--     produto: vazio nao bloqueia agendamento na Fase A; e so um metadado de gestao).
--
-- POR QUE AQUI E NAO EM 053: 053 ja foi mergeada/aplicada (release separada — regra de
--   ouro 9: nao alterar migration ja aplicada). Esta e uma migration NOVA, idempotente.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Re-rodar e no-op.
-- NAO destrutiva: nenhum DROP/DELETE/TRUNCATE; coluna nullable com default (sem reescrita
--   de linha que trave). Individual = 0 linhas em clone_colaboradores -> nenhum pagante
--   (Cirilo/Samuel) e tocado.
--
-- ── ROLLBACK (manual; release separada; so com aprovacao do Bruno) ──────────────────
--   BEGIN;
--     ALTER TABLE clone_colaboradores DROP COLUMN IF EXISTS servicos;
--   COMMIT;
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE clone_colaboradores
  ADD COLUMN IF NOT EXISTS servicos JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN clone_colaboradores.servicos IS
  'Servicos que este colaborador faz (array de servico_nome, espelha flow_clones.servicos[].nome). '
  '[] = nao especificado (nao bloqueia agenda na Fase A; metadado de gestao). ADR 0023.';

COMMIT;
