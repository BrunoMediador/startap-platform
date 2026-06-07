-- Migration 039: usuarios do Portal do Cliente (app.startap.tech).
--
-- Missao 009 / ADR 0012. Auth dedicada do portal publico, separada do admin
-- hardcoded do painel-admin. Cada user do portal loga e gerencia 1 fluxo (clone).
--
-- Modelagem N:N-ready: portal_users (credenciais) + portal_user_clones (vinculo
-- user->slot). Na v1 o vinculo e travado em 1:1 por um UNIQUE INDEX em user_id.
-- Na v2, dropar esse indice libera N clones por user SEM migration de dados.
--
-- bcrypt cost 12 aplicado na camada de aplicacao (painel-admin cria/reseta senha).
-- A coluna password_hash guarda apenas o hash — nunca senha em claro.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS.
-- Aditiva: nao altera nenhuma tabela/coluna existente.
--
-- Rollback (reversivel — nunca dropar na mesma release que adiciona):
--   DROP INDEX IF EXISTS ux_portal_user_single_clone_v1;
--   DROP TABLE IF EXISTS portal_user_clones;
--   DROP INDEX IF EXISTS ux_portal_users_username;
--   DROP TABLE IF EXISTS portal_users;

BEGIN;

CREATE TABLE IF NOT EXISTS portal_users (
  id                   BIGSERIAL PRIMARY KEY,
  -- slot do clone que este user gerencia. Mantido tambem em portal_user_clones
  -- (fonte do withTenant). Aqui serve de referencia direta e simplifica a v1.
  slot                 VARCHAR(80)  NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  username             VARCHAR(80)  NOT NULL,
  password_hash        TEXT         NOT NULL,
  display_name         VARCHAR(160),
  active               BOOLEAN      NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN      NOT NULL DEFAULT TRUE,
  -- Lockout progressivo de login (rate limit / brute-force).
  failed_attempts      INTEGER      NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- username unico global (case-insensitive via lower() para evitar "Cirilo" vs "cirilo").
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_users_username
  ON portal_users (lower(username));

CREATE INDEX IF NOT EXISTS idx_portal_users_slot
  ON portal_users (slot);

-- Tabela de associacao N:N-ready user->slot. Na v1, cada user enxerga 1 clone.
CREATE TABLE IF NOT EXISTS portal_user_clones (
  user_id    BIGINT       NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  slot       VARCHAR(80)  NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  role       VARCHAR(24)  NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, slot)
);

-- Trava 1:1 na v1: cada user vinculado a no maximo 1 slot.
-- Dropar este indice na v2 libera N:N sem migration de dados.
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_user_single_clone_v1
  ON portal_user_clones (user_id);

CREATE INDEX IF NOT EXISTS idx_portal_user_clones_slot
  ON portal_user_clones (slot);

COMMIT;
