-- Migration 065: colaborador_auth — credenciais de LOGIN do COLABORADOR (barbeiro)
-- de um cliente ESTABELECIMENTO no Portal do Cliente (SCRUM-32, painel do colaborador).
--
-- CONTEXTO: clientes product_type='estabelecimento' têm N colaboradores em
-- clone_colaboradores (migration 053). O DONO já gerencia esses colaboradores no
-- painel de gestão. Esta tabela dá a CADA colaborador um login PRÓPRIO (usuário +
-- senha) pro portal, com visão READ-ONLY e ESCOPADA só aos dados DELE (a agenda dele
-- e a comissão/faturamento DELE). NUNCA vê dado de outro colaborador, do dono ou de
-- outro tenant.
--
-- POR QUE TABELA DEDICADA (e não colunas em clone_colaboradores):
--   1. ISOLAMENTO DE SEGREDO: password_hash fica FORA da linha de colaborador que o
--      dono lê/edita no painel (GET /api/clones/:id/colaboradores e portal-equipe
--      nunca selecionam esta tabela) — o hash não vaza por engano num SELECT *.
--   2. Mantém clone_colaboradores focada no domínio de agenda/comissão.
--   3. 1:1 com o colaborador (PK = colaborador_id) — sem ambiguidade.
--
-- USERNAME (decisão do PM/Bruno): derivado do NOME do colaborador (slug: minúsculas,
-- sem acento, espaços→hífen). É ÚNICO POR CLONE porque clone_colaboradores já força
-- UNIQUE(slot, lower(nome)); aqui exigimos unicidade GLOBAL (índice abaixo) pra o login
-- — que recebe só o username, sem slot — ser inequívoco. Colisão global (nome igual em
-- OUTRO clone, ou dois nomes que geram o mesmo slug) ganha sufixo numérico (-2, -3...)
-- aplicado na geração (painel-admin). A senha NUNCA é persistida em claro — só o hash
-- (bcrypt cost 12, MESMO esquema de portal_users); o texto aparece UMA vez na resposta
-- da geração pro dono repassar ao colaborador.
--
-- ISOLAMENTO (regra de ouro 5 / ADR 0018): carrega slot + tenant_id desde o nascimento
-- (caminho RLS futuro, igual 053/056/058). O portal escopa TODA leitura por
-- (tenant do clone + colaborador_id DA SESSÃO) — nunca por id de input.
--
-- ADITIVA + IDEMPOTENTE: só CRIA tabela/índices novos (IF NOT EXISTS). NÃO toca nenhuma
-- linha/coluna existente. Feature dormente atrás da flag COLABORADOR_PORTAL_ENABLED.
--
-- ROLLBACK (reversível — ADR 0009 do repo / regra de ouro 9): a release que adiciona
-- esta tabela NÃO dropa nada. Para reverter manualmente (nenhuma outra tabela depende
-- desta):
--   DROP TABLE IF EXISTS colaborador_auth;

CREATE TABLE IF NOT EXISTS colaborador_auth (
  colaborador_id  BIGINT      PRIMARY KEY
                              REFERENCES clone_colaboradores(id) ON DELETE CASCADE,
  -- slot + tenant_id denormalizados pro escopo rápido + caminho RLS (espelha 058).
  slot            TEXT        NOT NULL REFERENCES flow_clones(slot) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL,
  -- username de login (slug do nome). Unicidade GLOBAL no índice funcional abaixo.
  username        TEXT        NOT NULL,
  -- bcrypt (cost 12) — calculado na camada de aplicação (painel-admin gera; portal-api
  -- compara). A camada de DB NUNCA gera/compara hash. Texto puro JAMAIS persiste aqui.
  password_hash   TEXT        NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  -- lockout progressivo de login (MESMO esquema de portal_users).
  failed_attempts INT         NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Login recebe só o username (sem slot) -> unicidade GLOBAL case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS ux_colaborador_auth_username_global
  ON colaborador_auth (lower(username));

-- Escopo por tenant (defesa em profundidade / caminho RLS).
CREATE INDEX IF NOT EXISTS ix_colaborador_auth_slot_tenant
  ON colaborador_auth (slot, tenant_id);
