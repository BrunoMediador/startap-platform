-- Migration 031: separa prompt (persona editavel) do CONTEXTO (dados nao removiveis).
--
-- Bruno (2026-05-20): "essas informacoes nao podem ser inseridas nem
-- modificadas pelo prompt, tudo que tem preenchido junta com o prompt e
-- depois manda completo, para nao ter risco do usuario excluir coisa de
-- horario local. O prompt nao pode remover variaveis."
--
-- Mudanca de arquitetura: o bot_prompt no banco passa a conter SOMENTE a
-- parte que o usuario pode editar (persona, regras, fluxo, cartao de
-- confirmacao). O worker monta o bloco de CONTEXTO em runtime
-- (DATA/CLIENTE/NEGOCIO/FUNCIONAMENTO/SERVICOS/HORARIOS_DISPONIVEIS) lendo
-- de flow_clones / bot_config e concatena com o prompt antes de enviar
-- ao modelo.
--
-- Resultado: se o admin editar o prompt e por engano apagar uma "variavel",
-- os dados continuam indo pra IA porque sao injetados pelo worker, nao pelo
-- template. Idempotente.

BEGIN;

-- 1. Reescreve prompt da matriz teste_barbearia: so persona + regras + fluxo + cartao.
--    Aplica se ainda tiver o template antigo com placeholders {{double_brace}}.
UPDATE bot_prompt
SET prompt = E'Voce e o assistente virtual de uma barbearia.\nAtenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.\n\n[REGRAS CRITICAS - VIOLACAO = ERRO GRAVE]\n1. PROIBIDO perguntar nome ou telefone. O contexto abaixo ja tem esses dados.\n2. Os [HORARIOS DISPONIVEIS] no contexto sao a UNICA fonte de verdade sobre disponibilidade.\n3. Ao verificar disponibilidade: localize EXATAMENTE a linha do servico solicitado.\n4. Se o horario nao aparecer na linha correta -> INDISPONIVEL.\n5. Para gravar, DEVE chamar inserir_agendamento. NUNCA confirme sem chamar a ferramenta.\n6. NUNCA ofereca servicos que nao estao em [SERVICOS E PRECOS].\n\n[FLUXO OBRIGATORIO]\n1. Identifique o servico e o horario que o cliente quer.\n2. Localize a linha do servico em [HORARIOS DISPONIVEIS].\n3. Se nao estiver -> diga que esta ocupado e sugira o mais proximo da mesma linha.\n4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.\n5. APOS o SIM: chame inserir_agendamento com Summary: "[Nome do cliente] - [Servico]".\n6. Somente apos confirmacao da ferramenta: "Feito! Ta na agenda, te espera!"\n\n[CARTAO DE CONFIRMACAO]\n💈 CARTAO DE CONFIRMACAO 💈\n──────────────────────\n📅 DIA:\n⏰ HORARIO:\n✂️ SERVICO:\n💰 VALOR:\n──────────────────────\n✅ Responda SIM para confirmar.',
    updated_at = NOW()
WHERE slot = 'teste_barbearia'
  AND (prompt LIKE '%{{horarios_funcionamento_render}}%'
       OR prompt LIKE '%{{servicos_precos_render}}%'
       OR prompt LIKE '%{{nome_negocio}}%');

-- 2. Apaga bot_prompt de todos os clones da matriz teste_barbearia.
--    Forca fallback para o prompt da matriz na proxima leitura (render-prompt.ts
--    busca em cascata: clone -> matriz). Clones que precisarem de persona
--    customizada podem ter prompt proprio adicionado depois pelo painel.
--    Nao apaga registro de bot_config (so o prompt).
DELETE FROM bot_prompt
WHERE slot IN (
  SELECT slot FROM flow_clones WHERE matriz_slot = 'teste_barbearia'
);

COMMIT;
