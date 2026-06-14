-- Migration 051: ÁREA/VERTICAL por clone + matriz teste_barbearia parametrizada por {{area_artigo}}.
--
-- Missão 023 W8. O cliente passa a ESCOLHER a área no cadastro self-service
-- (barbearia/cabeleireiro/manicure/estetica/outro) e o prompt genérico adapta o
-- TOM e o substantivo ("a barbearia" vs "o salao" vs "o studio de estetica").
--
-- DUAS partes, ambas ADITIVAS e REVERSÍVEIS:
--   1) flow_clones.area VARCHAR(32) (nullable) + backfill 'barbearia' nos clones atuais.
--      A TAXONOMIA é validada por Zod NO APP (signup), NÃO por CHECK no banco — assim a
--      lista de verticais evolui sem nova migration (decisão do design W8).
--   2) Reescreve o PROMPT DA MATRIZ `teste_barbearia` trocando o "uma barbearia"
--      hardcoded por {{area_artigo}} + adiciona o bloco [TOM POR AREA] (template do
--      ai-engineer, Missão 023 W8). O render do clone (renderClonePrompt) resolve
--      {{area}}/{{area_artigo}} pelo mesmo mecanismo do {{nome_negocio}}.
--
-- ⚠️ POR QUE ISTO NÃO RE-RENDERIZA CLONES JÁ EXISTENTES (incl. Cirilo pagante):
--   O bot lê o prompt EXCLUSIVAMENTE do bot_prompt do PRÓPRIO slot do clone
--   (apps/api/src/lib/render-prompt.ts -> botPrompt.getPrompt(slot)). NÃO há cascata
--   clone->matriz em runtime. Logo, mudar o prompt da MATRIZ aqui NÃO altera o texto
--   que Cirilo/Edu/Samuel já têm persistido. Só clones NOVOS (renderizados a partir
--   desta matriz no provisionamento) nascem com {{area_artigo}} resolvido.
--   O re-render explícito dos clones existentes (regerarPromptClone) é um PASSO
--   GATED SEPARADO, fora deste PR/migration. Esta migration NÃO toca nenhuma linha de
--   bot_prompt de clone.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS; backfill com WHERE area IS NULL; UPDATE do
-- prompt guardado por WHERE que casa o template atual (031) — re-rodar é no-op.
-- NÃO destrutiva: nenhum DROP/DELETE/TRUNCATE; nenhuma coluna removida.
--
-- ── ROLLBACK (rodar manualmente; NUNCA no mesmo release — regra de ouro 9) ─────────
--   BEGIN;
--   -- restaura o prompt persona-only da matriz (texto exato da migration 031):
--   UPDATE bot_prompt
--   SET prompt = E'Voce e o assistente virtual de uma barbearia.\n...'  -- ver 031
--   WHERE slot = 'teste_barbearia';
--   ALTER TABLE flow_clones DROP COLUMN IF EXISTS area;
--   COMMIT;
--   → coluna some; matriz volta ao texto barbearia-only. Clones já criados ficam
--     intactos (têm prompt próprio persistido).
-- ─────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Coluna area (nullable; default conceitual 'outro'/'generico' resolvido NO APP,
--    não no DDL — pra distinguir "clone antigo sem area" de "cliente escolheu outro").
ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS area VARCHAR(32);

COMMENT ON COLUMN flow_clones.area IS
  'Vertical do negocio (barbearia/cabeleireiro/manicure/estetica/outro). Taxonomia validada por Zod no app (signup), NAO por CHECK aqui. NULL = clone antigo pre-W8 (tratado como generico no render).';

-- Backfill: todos os clones atuais são barbearia (única matriz em prod hoje é
-- teste_barbearia). Só preenche onde está NULL — idempotente e não sobrescreve
-- nada que já tenha área.
UPDATE flow_clones
SET area = 'barbearia', updated_at = NOW()
WHERE area IS NULL AND matriz_slot = 'teste_barbearia';

-- 2) Reescreve o PROMPT DA MATRIZ teste_barbearia: persona-only (igual 031) MAS com
--    {{area_artigo}} no lugar de "uma barbearia" + bloco [TOM POR AREA]. O render do
--    clone resolve {{area_artigo}} (frase pronta com artigo) no provisionamento.
--    GUARDA (WHERE): casa o template persona-only vigente (migration 031) — assim a
--    reescrita só roda uma vez e nunca aplica sobre um template inesperado.
--    NÃO toca nenhum bot_prompt de CLONE (filtro slot = 'teste_barbearia').
UPDATE bot_prompt
SET prompt = E'Voce e o assistente virtual de {{nome_negocio}}, {{area_artigo}}.\nAtenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.\n\n[REGRAS CRITICAS - VIOLACAO = ERRO GRAVE]\n1. PROIBIDO perguntar nome ou telefone. O contexto abaixo ja tem esses dados.\n2. Os [HORARIOS DISPONIVEIS] no contexto sao a UNICA fonte de verdade sobre disponibilidade.\n3. Ao verificar disponibilidade: localize EXATAMENTE a linha do servico solicitado.\n4. Se o horario nao aparecer na linha correta -> INDISPONIVEL.\n5. Para gravar, DEVE chamar inserir_agendamento. NUNCA confirme sem chamar a ferramenta.\n6. NUNCA ofereca servicos que nao estao em [SERVICOS E PRECOS].\n7. So fale sobre {{nome_negocio}} e seus servicos. Fora disso, redirecione com gentileza.\n\n[FLUXO OBRIGATORIO]\n1. Identifique o servico e o horario que o cliente quer.\n2. Localize a linha do servico em [HORARIOS DISPONIVEIS].\n3. Se nao estiver -> diga que esta ocupado e sugira o mais proximo da mesma linha.\n4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.\n5. APOS o SIM: chame inserir_agendamento com Summary: "[Nome do cliente] - [Servico]".\n6. Somente apos confirmacao da ferramenta: "Feito! Ta na agenda, te espera!"\n\n[CARTAO DE CONFIRMACAO]\n💈 CARTAO DE CONFIRMACAO 💈\n──────────────────────\n📅 DIA:\n⏰ HORARIO:\n✂️ SERVICO:\n💰 VALOR:\n──────────────────────\n✅ Responda SIM para confirmar.\n\n[TOM POR AREA]\nVoce atende {{area_artigo}}. Use o vocabulario natural desse tipo de negocio,\nmas NUNCA invente servicos ou precos fora de [SERVICOS E PRECOS].',
    updated_at = NOW()
WHERE slot = 'teste_barbearia'
  AND prompt LIKE '%assistente virtual de uma barbearia%'
  AND prompt NOT LIKE '%{{area_artigo}}%';

COMMIT;
