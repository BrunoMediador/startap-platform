-- Migration 066: clone_colaboradores.gcal_last_check_at — carimbo da última validação da agenda.
--
-- MOTIVO (SCRUM-27 — "active mentiroso"): o status GCal de um colaborador só muda quando alguém
--   clica "Testar conexão" no painel (POST /api/clones/:id/colaboradores/:colabId/gcal/test). Uma
--   agenda pode quebrar (permissão revogada, calendarId apagado) e seguir marcada 'active' — o bot
--   acha que agenda e silencia. O novo cron de health-check (worker: gcal-healthcheck) revalida as
--   agendas periodicamente e precisa registrar QUANDO cada colaborador foi checado pela última vez,
--   tanto para mostrar no painel "verificado há X" quanto para o próprio cron priorizar os mais
--   ANTIGOS (ORDER BY gcal_last_check_at ASC NULLS FIRST) e dar a volta em todos sob o teto por ciclo.
--
-- flow_clones já tem gcal_last_check_at (migration 018). Esta coluna espelha aquela em
--   clone_colaboradores (caminho estabelecimento, ADR 0024 — 1 SA do clone, N calendarIds por
--   colaborador). Sem ela, o cron não teria onde gravar o "last_check" do colaborador.
--
-- ISOLAMENTO / multi-tenancy: coluna mora em clone_colaboradores, que já carrega slot + tenant_id
--   (migration 053). Aditivo puro — não toca dado existente, não piora a dívida P0 de multi-tenancy.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Re-rodar é no-op. NULL = nunca checado pelo cron ainda
--   (estado inicial legítimo; o cron prioriza justamente esses primeiro).
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida; nada na mesma release.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação do Bruno) ──
--   BEGIN;
--   ALTER TABLE clone_colaboradores DROP COLUMN IF EXISTS gcal_last_check_at;
--   COMMIT;
--   → a coluna some. O cron volta a só atualizar gcal_status + updated_at (sem last_check do colab).
-- ───────────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Carimbo da última revalidação automática da agenda deste colaborador (NULL = nunca checado).
ALTER TABLE clone_colaboradores ADD COLUMN IF NOT EXISTS gcal_last_check_at TIMESTAMPTZ;

COMMENT ON COLUMN clone_colaboradores.gcal_last_check_at IS
  'Quando o cron gcal-healthcheck (ou o teste manual do painel) revalidou esta agenda pela última vez. NULL = nunca checado.';

COMMIT;
