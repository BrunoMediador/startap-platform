-- Migration 016 — Placeholder de gap de numeração
--
-- Contexto: migration 016 nunca foi criada como arquivo. As migrations 015 e 017
-- foram geradas em PRs consecutivos sem que nenhuma mudança de schema fosse
-- necessária nesse intervalo (PR entre missões 015-consolidate-legacy e
-- 017-flow-clones-chat-table não gerou DDL).
--
-- Esta migration existe SOMENTE para fechar o gap de numeração e manter o gate
-- defensivo do deploy.sh consistente (COUNT(*.sql) == COUNT(schema_migrations)).
--
-- Não altera dados nem schema.

SELECT 1;
