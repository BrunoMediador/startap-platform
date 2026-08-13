-- Baseline minimo anterior ao historico versionado do startap-platform.
--
-- O repositorio foi criado com producao ja em andamento e as migrations comecam em 002.
-- Estas duas tabelas legadas ja existiam no banco original e sao pre-condicoes de 014 e 025.
-- Este fixture roda SOMENTE no gate de CI; nao faz parte do runner de producao.

CREATE TABLE leads_ricardo (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT,
  telefone VARCHAR(32) NOT NULL,
  mensagem_inicial TEXT,
  origem TEXT,
  criado_em TIMESTAMP DEFAULT NOW()
);

CREATE TABLE bot_pausa (
  numero_cliente VARCHAR(32) PRIMARY KEY,
  pausado BOOLEAN NOT NULL DEFAULT TRUE
);
