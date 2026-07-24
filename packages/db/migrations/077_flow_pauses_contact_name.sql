-- Migration 077: nome do contato durável na pausa + store durável de pushName (SCRUM-144).
--
-- PROBLEMA: flow_pauses guarda só o telefone. O nome que o /pausas exibe hoje viria de
-- getRecentContacts (WAHA GET /chats), mas o store NOWEB está OFF → /chats falha → cai no
-- fallback por message_log, que devolve name=null. Ou seja: nenhum nome resolve, e o dono
-- vê só números. Pra o nome DURAR (independente da janela de recentes e do store do WAHA)
-- ele tem que ser CAPTURADO e SNAPSHOTADO na própria pausa.
--
-- ENTREGA 1 — coluna aditiva em flow_pauses: `contact_name` (nome snapshotado na criação da
--   pausa; NULL = não capturado). A leitura (listPausasBySlot) passa a devolvê-la; o portal
--   prefere ela ao join volátil com recent-contacts.
--
-- ENTREGA 2 — store durável `contact_names`: fonte de verdade do pushName por contato,
--   populada pelo INBOUND (cliente→bot) no webhook (o pushName vem no payload, NÃO depende do
--   store do WAHA). Chave = (session, phone_key) onde phone_key é a forma canônica E.164
--   INVARIANTE ao 9º dígito (canonicalE164) — o WAHA/Baileys ora entrega o número COM o 9, ora
--   SEM (SCRUM-82), então canonicalizar garante que inbound e snapshot batam no mesmo contato.
--   É a esta store que a pausa fromMe/human_reply recorre pra descobrir o nome do CONTATO (o
--   pushName do evento fromMe seria o nome do DONO, não serve).
--
-- POR QUE TABELA NOVA (e não reviver `waba_contatos`): waba_contatos existe em prod mas está
--   VAZIA, tem ZERO referências no código e NÃO é criada por nenhuma migration deste repo
--   (legado provisionado por fora) — sua constraint única / colunas NOT NULL são
--   inverificáveis, então um ON CONFLICT (upsert) contra ela não é seguro num hot-path que
--   TEM que ser fail-safe. Uma tabela mínima com PK explícita, de posse deste código, é
--   segura, testável e isolável.
--
-- ADITIVA e REVERSÍVEL: ADD COLUMN IF NOT EXISTS + CREATE TABLE/INDEX IF NOT EXISTS. Sem
-- DROP/DELETE/TRUNCATE. Rollback (release SEPARADA — regra de ouro 9): DROP COLUMN contact_name
-- e DROP TABLE contact_names. A feature de captura também é kill-switch por env no app.

BEGIN;

-- 1. Nome do contato snapshotado na pausa. NULL em toda linha existente = byte-idêntico.
ALTER TABLE flow_pauses ADD COLUMN IF NOT EXISTS contact_name TEXT NULL;

-- 2. Store durável phone→pushName por sessão. phone_key = canonicalE164 (9º-dígito-invariante).
CREATE TABLE IF NOT EXISTS contact_names (
  session    TEXT NOT NULL,
  phone_key  TEXT NOT NULL,          -- canonicalE164(telefone) (dígitos DDI, invariante ao 9)
  push_name  TEXT NOT NULL,          -- último pushName visto (só inbound, nunca fromMe)
  phone      TEXT NULL,              -- última forma crua vista (diagnóstico; não é chave)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session, phone_key)
);

COMMIT;
