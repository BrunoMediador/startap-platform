-- Migration 061: Credencial Google do CLIENTE (login do Google Agenda no cel/PC).
--
-- O QUE É: a empresa CRIA uma conta Google (e-mail + senha) pro cliente logar no app
--   Google Agenda no celular/computador dele. Essas colunas guardam essa credencial pra
--   o portal ENTREGAR ao dono (GET /portal/google-conta). É a credencial de LOGIN HUMANO.
--
-- ⚠️ NÃO CONFUNDIR com a Service Account do bot (colunas gcal_* — escopo TOTALMENTE
--   diferente, ADR 0024). A SA é a identidade que o BOT usa pra escrever na agenda; estas
--   colunas são o login que o HUMANO usa no app do Google. Esta migration NÃO toca gcal_*.
--
-- COLUNAS NOVAS em `flow_clones` (todas ADITIVAS, sem default, sem backfill):
--   * google_account_email         — e-mail da conta Google criada pra o cliente (texto claro;
--                                     não é segredo por si só, é só o identificador de login).
--   * google_account_password_enc  — SENHA cifrada no formato enc:v2:iv:tag:ciphertext
--                                     (encryptSecret/decryptSecret de @startap/core; MESMO
--                                     formato/chave do gcal). NUNCA em texto claro no banco.
--                                     O painel-admin produz o MESMO formato ao gravar.
--   * google_account_updated_at    — quando a credencial foi gravada/atualizada (auditoria).
--
-- ENTREGA: GET /portal/google-conta decifra a senha server-side e responde com
--   cache-control: no-store, gated por GOOGLE_ACCOUNT_PORTAL_ENABLED (default OFF). A senha
--   NUNCA entra em log (nem em erro).
--
-- ADITIVA: só ADD COLUMN IF NOT EXISTS. SEM default, SEM backfill, SEM tocar linha existente,
--   SEM mexer em colunas gcal_*. Nenhum clone existente é afetado (colunas nascem NULL).
--
-- Idempotente: re-rodar é no-op (IF NOT EXISTS). NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação
--    explícita do Bruno) ──────────────────────────────────────────────────────────────
--   BEGIN;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS google_account_updated_at;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS google_account_password_enc;
--     ALTER TABLE flow_clones DROP COLUMN IF EXISTS google_account_email;
--   COMMIT;
--   → colunas somem; produção idêntica a antes. Flag OFF = nenhum cliente afetado.
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS google_account_email TEXT,
  ADD COLUMN IF NOT EXISTS google_account_password_enc TEXT,
  ADD COLUMN IF NOT EXISTS google_account_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN flow_clones.google_account_email IS
  'E-mail da conta Google criada PRA O CLIENTE logar no Google Agenda (login humano). NÃO é a Service Account do bot (gcal_*). Migration 061.';
COMMENT ON COLUMN flow_clones.google_account_password_enc IS
  'Senha da conta Google do cliente, cifrada enc:v2:iv:tag:ciphertext (encrypt/decryptSecret de @startap/core). Decifrada server-side só em GET /portal/google-conta. Migration 061.';
COMMENT ON COLUMN flow_clones.google_account_updated_at IS
  'Quando a credencial Google do cliente foi gravada/atualizada (auditoria). Migration 061.';

COMMIT;
