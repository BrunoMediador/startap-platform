-- Migration 027: horarios_funcionamento + servicos por clone
--
-- Resolve o bug onde o prompt da matriz teste_barbearia tem horarios e servicos
-- HARDCODED da Barbearia Startap, gerando confusao para clones de outros barbeiros
-- (slots de 30 e 40 min que nao existem no negocio do cliente).
--
-- Estrutura:
--   horarios_funcionamento jsonb com chaves segunda..domingo,
--     cada chave: { abre: "HH:MM"|null, fecha: "HH:MM"|null, fechado: boolean }
--   servicos jsonb array de { nome, preco_cents, duracao_min }
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Reescrita do bot_prompt da matriz so
-- aplica se o prompt ainda for o legado (heuristica: contem "Barbearia Startap").
--
-- Memoria feedback_prompt_no_banco_sincronizado: migration que mexe em catalogo
-- e marcadores PRECISA atualizar bot_prompt no mesmo PR.

BEGIN;

-- 1. Colunas novas em flow_clones
ALTER TABLE flow_clones
  ADD COLUMN IF NOT EXISTS horarios_funcionamento jsonb,
  ADD COLUMN IF NOT EXISTS servicos jsonb;

-- 2. Reescreve prompt da matriz teste_barbearia trocando blocos hardcoded por
--    placeholders {{double_brace}} que o painel substitui ao criar/atualizar clone.
--    Mantem placeholders {single_brace} que o worker substitui em runtime.
--    Aplica APENAS se ainda for o prompt legado da Startap (idempotente).
UPDATE bot_prompt
SET prompt = E'Voce e o assistente virtual de {{nome_negocio}}.\nAtenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.\n\n[DATA ATUAL]\n{data_atual}\nANO: {ano} - use SEMPRE este ano ao calcular datas.\n\n[DADOS DO CLIENTE - JA IDENTIFICADO]\nNOME: {nome}\nWHATSAPP: {telefone}\n\n[NEGOCIO]\nNome: {{nome_negocio}}\nEndereco: {{endereco}}\nInstagram: @{{instagram}}\n\n[HORARIOS DISPONIVEIS - DADOS ATUALIZADOS AGORA]\n{agenda}\n\n[SERVICOS E PRECOS]\n{{servicos_precos_render}}\n\n[FUNCIONAMENTO]\n{{horarios_funcionamento_render}}\n\n[REGRAS CRITICAS - VIOLACAO = ERRO GRAVE]\n1. PROIBIDO perguntar nome ou telefone. Voce ja tem esses dados acima.\n2. Os [HORARIOS DISPONIVEIS] acima sao a UNICA fonte de verdade sobre disponibilidade.\n3. Ao verificar disponibilidade: localize EXATAMENTE a linha do servico solicitado.\n4. Se o horario nao aparecer na linha correta -> INDISPONIVEL.\n5. Para gravar, DEVE chamar inserir_agendamento. NUNCA confirme sem chamar a ferramenta.\n6. NUNCA ofereca servicos que nao estao em [SERVICOS E PRECOS] acima.\n\n[FLUXO OBRIGATORIO]\n1. Identifique o servico e o horario que o cliente quer.\n2. Localize a linha do servico em [HORARIOS DISPONIVEIS].\n3. Se nao estiver -> diga que esta ocupado e sugira o mais proximo da mesma linha.\n4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.\n5. APOS o SIM: chame inserir_agendamento com Summary: "{nome} - [SERVICO]".\n6. Somente apos confirmacao da ferramenta: "Feito! Ta na agenda, {{nome_negocio}} te espera!"\n\nUse esse texto como um exemplo de um cartao de confirmacao\n\n💈 CARTAO DE 💈 CONFIRMACAO 💈\n──────────────────────\n📅 DIA:\n⏰ HORARIO:\n✂️ SERVICO:\n💰 VALOR:\n──────────────────────\n✅ Responda SIM para confirmar.',
    updated_at = NOW()
WHERE slot = 'teste_barbearia'
  AND prompt LIKE '%Barbearia Startap%';

-- 3. Seed de horarios padrao para clones existentes que ainda nao tem.
--    Padrao: terca-sabado 09-18, fechado domingo e segunda.
UPDATE flow_clones
SET horarios_funcionamento = jsonb_build_object(
      'segunda',  jsonb_build_object('abre', NULL,    'fecha', NULL,    'fechado', true),
      'terca',    jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'quarta',   jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'quinta',   jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'sexta',    jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'sabado',   jsonb_build_object('abre', '09:00', 'fecha', '18:00', 'fechado', false),
      'domingo',  jsonb_build_object('abre', NULL,    'fecha', NULL,    'fechado', true)
    ),
    updated_at = NOW()
WHERE horarios_funcionamento IS NULL
  AND matriz_slot = 'teste_barbearia';

-- 4. Seed de servicos: array vazio. Cliente preenche via painel; com array vazio
--    o render gera "Nenhum servico cadastrado" e a IA nao oferece nada ate
--    o cliente cadastrar — comportamento intencional para evitar herdar precos
--    e duracoes da Startap por engano.
UPDATE flow_clones
SET servicos = '[]'::jsonb,
    updated_at = NOW()
WHERE servicos IS NULL
  AND matriz_slot = 'teste_barbearia';

COMMIT;
