-- Baseline minimo anterior ao historico versionado do startap-platform.
--
-- O repositorio foi criado com producao ja em andamento e as migrations comecam em 002.
-- Estas tabelas legadas ja existiam no banco original. leads_ricardo e bot_pausa sao
-- pre-condicoes de 014 e 025; message_log e consumida pelo runtime de API/worker. O contrato de
-- message_log abaixo reproduz o schema public medido em 2026-08-13, sem criar migration produtiva.
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

CREATE TABLE message_log (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  chat_id VARCHAR(100)
);

CREATE INDEX idx_message_log_phone_time ON message_log (phone, created_at);
CREATE INDEX idx_message_log_chat_created ON message_log (chat_id, created_at);
