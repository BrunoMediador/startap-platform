-- Migration 048: backfill pontual de tenant_id nas satélites — fecha o GAP de
-- escrita entre a migration 045 (Fase 1, backfill único) e o deploy do #287
-- (dual-write em produção). ADR 0018, Fase 2.
--
-- CONTEXTO (causa raiz da regressão achada pelo QA em 2026-06-13):
--   A 045 fez UM backfill pontual e adicionou tenant_id NULLABLE nas satélites.
--   Toda escrita NOVA entre a 045 e o deploy do #287 nasceu com tenant_id NULL,
--   porque o código que carimba tenant_id (logUsage -> resolveTenantId) só passou
--   a rodar em prod quando o container startap-api/worker subiu com o build do #287
--   (merge 2026-06-13 19:27:37Z; imagem buildada 19:33:37Z; container Up 19:34:14Z).
--   Resultado concreto: 21 linhas de model_usage do clone do Cirilo
--   (clone_cirilobarbearia_c8w2f0), todas com created_at entre 10:37 e 19:28 UTC do
--   dia 13 — ou seja, ANTES do build novo entrar em produção. A última NULL
--   (id 1412) é de 19:28:59, ~6 min antes do deploy. Não é bug de código: o
--   dual-write está correto e presente no build rodando (verificado no dist do
--   container). É um gap temporal de deploy. Esta migration reidrata essas linhas.
--
-- ESCOPO (estritamente clones REAIS, resolvidos via flow_clones):
--   Reaplica o MESMO UPDATE idempotente da 045 em todas as satélites slot-anchored.
--   Como o backfill chaveia por `WHERE s.slot = fc.slot`, só toca linhas cujo slot
--   EXISTE em flow_clones (a âncora canônica do tenant). Slots de plataforma
--   (startap/Lola, teste_barbearia/matriz, teste_vendas*) e clones órfãos/antigos
--   que NÃO estão em flow_clones (clone_ricardo_*, clone_cirilo_barbaershop_4dt9pc,
--   clone_bruno_*) permanecem tenant_id NULL DE PROPÓSITO — exatamente como a 045 e
--   o ADR especificam. Esta migration NÃO os toca.
--
--   Estado medido em prod (read-only, 2026-06-13) — NULL em satélites de clones que
--   ESTÃO em flow_clones (Cirilo/Samuel/Edu/Carlos-teste):
--     model_usage    : 21 (todas do Cirilo) -> serão carimbadas
--     bot_config     : 0
--     bot_prompt     : 0
--     bot_media      : 0
--     bot_courses    : 0
--     client_billing : 0
--     billing_charges: 0
--   Ou seja: na prática esta migration só reidrata as 21 linhas do model_usage do
--   Cirilo. As demais satélites já estavam 100% carimbadas pela 045. Mantemos os
--   UPDATEs de todas elas por segurança/idempotência (no-op onde já está preenchido)
--   e para cobrir qualquer escrita-gap residual antes do deploy.
--
-- ISOLAMENTO: a tenant key em uso continua sendo `slot`. Ninguém lê por tenant_id
--   ainda (cutover = #288, com OK do Bruno). Não toca WAHA, não muda caminho de
--   leitura/escrita, não piora postura de RLS. 100% camada de banco, aditivo.
--
-- IDEMPOTENTE: guard `AND s.tenant_id IS NULL` em todo UPDATE. Roda 2x sem efeito;
--   a 2ª é no-op. Validado em prod via dry-run em transação ROLLBACK (UPDATE 21 no
--   model_usage, UPDATE 0 nas demais; plataforma/órfãos intactos).
--
-- REVERSÍVEL (release separada, NUNCA dropar nada na mesma release):
--   Esta migration só PREENCHE tenant_id em linhas que estavam NULL. Para reverter
--   apenas o efeito desta migration (sem dropar colunas), volta a NULL as linhas que
--   foram carimbadas a partir de flow_clones:
--     BEGIN;
--       UPDATE model_usage    s SET tenant_id = NULL FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id = fc.tenant_id;
--       UPDATE bot_config     s SET tenant_id = NULL FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id = fc.tenant_id;
--       UPDATE bot_prompt     s SET tenant_id = NULL FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id = fc.tenant_id;
--       UPDATE bot_media      s SET tenant_id = NULL FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id = fc.tenant_id;
--       UPDATE bot_courses    s SET tenant_id = NULL FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id = fc.tenant_id;
--       UPDATE client_billing s SET tenant_id = NULL FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id = fc.tenant_id;
--       UPDATE billing_charges s SET tenant_id = NULL FROM flow_clones fc WHERE s.slot = fc.slot AND s.tenant_id = fc.tenant_id;
--     COMMIT;
--   (ATENÇÃO: o rollback acima também zeraria as linhas carimbadas pela própria 045,
--    pois usa o mesmo critério slot->tenant_id. Como esta migration não cria coluna
--    nem destrói dado, o rollback prático é raramente necessário — preferir
--    re-rodar o forward, que é seguro/idempotente.)
--
-- Nenhum dado de cliente é perdido. Tudo aqui é UPDATE de coluna nullable já
-- existente, escopado por slot resolvível.

BEGIN;

-- ============================================================
-- Backfill slot -> flow_clones.tenant_id (idêntico ao da 045).
-- Guard `s.tenant_id IS NULL` torna cada UPDATE idempotente e seguro.
-- Toca SOMENTE slots presentes em flow_clones (clones reais). Plataforma/órfãos
-- ficam NULL de propósito.
-- ============================================================

UPDATE model_usage s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE bot_config s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE bot_prompt s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE bot_media s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE bot_courses s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE client_billing s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

UPDATE billing_charges s
  SET tenant_id = fc.tenant_id
  FROM flow_clones fc
  WHERE s.slot = fc.slot AND s.tenant_id IS NULL;

COMMIT;
