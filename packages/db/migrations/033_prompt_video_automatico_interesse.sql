-- Migration 033: adiciona secao [COMPORTAMENTO AUTOMATICO DO SISTEMA] nos prompts
-- das matrizes teste_vendas e teste_vendas_barbearia (Missao 025).
--
-- O que muda: instrui a IA que o sistema ja envia o video intro automaticamente
-- ao processar [CURSO:<slug>], e que ela deve usar a biblioteca de midias para
-- envios contextuais adicionais via [VIDEO:<id>].
--
-- Deteccao custom vs default:
--   - Aplica UPDATE SOMENTE se o prompt NAO contiver '[COMPORTAMENTO AUTOMATICO DO SISTEMA]'
--     (ausencia indica que e o template da M024, nao customizado pelo cliente).
--   - Clones com esse bloco ja presente (ou qualquer prompt custom sem o marcador
--     de identidade da M024) nao sao tocados.
-- Idempotente: pode rodar mais de uma vez sem dano.

BEGIN;

-- 1. Atualiza matriz teste_vendas
UPDATE bot_prompt
SET prompt = prompt || E'\n\n[COMPORTAMENTO AUTOMATICO DO SISTEMA]\n- Quando o cliente emitir [CURSO:<slug>], o sistema envia automaticamente o video de apresentacao daquele curso. Voce nao precisa mencionar nem repetir esse primeiro video.\n- Voce TEM acesso a uma biblioteca de midias listada em [MIDIAS DISPONIVEIS] no contexto. Use-a conforme a conversa pedir: depoimentos, demo de modulo, screenshots, etc.\n- NUNCA repita midias ja enviadas (ids listados em [ESTADO DA CONVERSA] no contexto).\n- Para enviar uma midia adicional, emita [VIDEO:<media_id>] passando o ID numerico da midia.',
    updated_at = NOW()
WHERE slot = 'teste_vendas'
  AND prompt NOT LIKE '%[COMPORTAMENTO AUTOMATICO DO SISTEMA]%';

-- 2. Atualiza matriz teste_vendas_barbearia
UPDATE bot_prompt
SET prompt = prompt || E'\n\n[COMPORTAMENTO AUTOMATICO DO SISTEMA]\n- Quando o cliente emitir [CURSO:<slug>], o sistema envia automaticamente o video de apresentacao daquele curso. Voce nao precisa mencionar nem repetir esse primeiro video.\n- Voce TEM acesso a uma biblioteca de midias listada em [MIDIAS DISPONIVEIS] no contexto. Use-a conforme a conversa pedir: depoimentos, demo de modulo, screenshots, etc.\n- NUNCA repita midias ja enviadas (ids listados em [ESTADO DA CONVERSA] no contexto).\n- Para enviar uma midia adicional, emita [VIDEO:<media_id>] passando o ID numerico da midia.',
    updated_at = NOW()
WHERE slot = 'teste_vendas_barbearia'
  AND prompt NOT LIKE '%[COMPORTAMENTO AUTOMATICO DO SISTEMA]%';

-- 3. Propaga para clones do teste_vendas que ainda usam o template default da M024.
--    Clones com prompt customizado (ja com a secao ou sem o marker da M024) nao sao tocados.
UPDATE bot_prompt
SET prompt = (
  SELECT bp_matriz.prompt
  FROM bot_prompt bp_matriz
  WHERE bp_matriz.slot = 'teste_vendas'
),
    updated_at = NOW()
WHERE slot IN (
  SELECT fc.slot FROM flow_clones fc WHERE fc.matriz_slot = 'teste_vendas'
)
  AND prompt NOT LIKE '%[COMPORTAMENTO AUTOMATICO DO SISTEMA]%'
  AND prompt LIKE '%[MARCADORES DE ACAO - REGRAS CRITICAS]%';

-- 4. Propaga para clones do teste_vendas_barbearia que ainda usam o template default da M024.
UPDATE bot_prompt
SET prompt = (
  SELECT bp_matriz.prompt
  FROM bot_prompt bp_matriz
  WHERE bp_matriz.slot = 'teste_vendas_barbearia'
),
    updated_at = NOW()
WHERE slot IN (
  SELECT fc.slot FROM flow_clones fc WHERE fc.matriz_slot = 'teste_vendas_barbearia'
)
  AND prompt NOT LIKE '%[COMPORTAMENTO AUTOMATICO DO SISTEMA]%'
  AND prompt LIKE '%[MARCADORES DE ACAO - REGRAS CRITICAS]%';

COMMIT;
