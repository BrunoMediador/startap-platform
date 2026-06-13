-- Migration 046: Sistema de Alertas Interno (monitoramento → WhatsApp via Lola).
--
-- Spec: docs/missoes/021-sistema-alertas-interno.md (Fase 1 — backend).
--
-- Detector interno simples que avisa o time no WhatsApp quando uma sessão WAHA de
-- cliente (Cirilo/Samuel/Lola) cai, ou quando o /health do startap-api / o Postgres
-- ficam indisponíveis. SEM Prometheus/Grafana (boring/incremental). Config é GLOBAL
-- (alerta do time, não por-tenant) — por isso nenhuma destas tabelas carrega `slot`
-- como tenant key; o único `slot` aqui é o do REMETENTE (qual sessão WAHA envia).
--
-- ISOLAMENTO: estas tabelas não tocam bots, sessões de cliente, billing nem o eixo
-- `slot`/multi-tenancy. Aditivo puro — não piora a dívida P0 de multi-tenancy.
--
-- LGPD: alert_recipients guarda número de WhatsApp do TIME (Bruno/plantão), não de
-- cliente. São números conhecidos internos; sem CPF, sem dado de cliente.
--
-- Idempotente: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING.
-- Reversível (NUNCA no mesmo release que adiciona):
--   -- DROP TABLE IF EXISTS alert_states;
--   -- DROP TABLE IF EXISTS alert_recipients;
--   -- DROP TABLE IF EXISTS alert_config;
--   (dados são só config/estado do time — sem PII de cliente.)

BEGIN;

-- Destinatários dos alertas (até 5 — limite ENFORCE NO APP, não trigger; mantém
-- SQL boring). UNIQUE no telefone evita duplicata. phone = E.164 só dígitos.
CREATE TABLE IF NOT EXISTS alert_recipients (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20) NOT NULL UNIQUE,   -- E.164 só dígitos (ex: 5531999998888)
  label       VARCHAR(60),                   -- "Bruno", "Plantão" (opcional)
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Config global (1 linha, id=1 fixo). Flags por tipo de check + remetente + cooldown.
-- enabled = kill-switch QUENTE via UI (sem restart). sender_slot resolve a sessão WAHA
-- remetente (default 'startap' = Lola/STARTAP_AI_PROD via bot_config.waha_sessao).
CREATE TABLE IF NOT EXISTS alert_config (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,         -- kill-switch via UI
  sender_slot     VARCHAR(40) NOT NULL DEFAULT 'startap', -- resolve waha_sessao p/ remetente (Lola)
  cooldown_min    INT NOT NULL DEFAULT 30 CHECK (cooldown_min >= 5),
  check_waha      BOOLEAN NOT NULL DEFAULT TRUE,
  check_health    BOOLEAN NOT NULL DEFAULT TRUE,
  check_host      BOOLEAN NOT NULL DEFAULT FALSE,         -- disco/RAM ficam pra fase 2
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Máquina de estado anti-spam: 1 linha por check (PK = chave do check).
-- check_key ex.: 'waha:STARTAP_AI_PROD', 'api:health', 'pg:main', e a linha
-- sintética '__global__' que segura o hard cap global de mensagens por janela.
CREATE TABLE IF NOT EXISTS alert_states (
  check_key          VARCHAR(80) PRIMARY KEY,             -- 'waha:<sessao>', 'api:health', ...
  state              VARCHAR(10) NOT NULL DEFAULT 'up'     -- up|down
                     CHECK (state IN ('up', 'down')),
  down_since         TIMESTAMPTZ,
  last_alert_at      TIMESTAMPTZ,
  alert_count        INT NOT NULL DEFAULT 0,
  pending_down_count INT NOT NULL DEFAULT 0,               -- debounce (só api:health)
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
