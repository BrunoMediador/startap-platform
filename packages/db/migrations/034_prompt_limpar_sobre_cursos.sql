-- Migration 034: remove bloco [SOBRE OS CURSOS] dos prompts das matrizes
-- teste_vendas_barbearia e clone_ricardo_curso_barbearia_qcl1eb, e adiciona
-- [INSTRUCAO SOBRE CURSOS] instruindo a IA a usar [CURSOS DISPONIVEIS] do contexto.
--
-- Decisao #14 (2026-05-21): separar informacoes de cursos do prompt para
-- bot_courses.details_for_llm, evitando duplicacao e risco de dados desatualizados.
--
-- O bloco removido e:
--   [SOBRE OS CURSOS]
--   Duracao: 3 meses | 2x por semana
--   Horarios: Manha 09h-11h | Tarde 15h-17h
--   Inclui: Apostila completa, fardamento e suporte no grupo de WhatsApp
--   Diploma valido em mais de 122 paises - trabalha em qualquer lugar do Brasil
--   Curso pratico, do zero ao profissional
--
-- Idempotente: guards com LIKE garantem que nao duplica nem quebra se rodar mais de uma vez.
-- NAO toca: teste_barbearia (Cirilo, sem cursos), teste_vendas (sem clone em prod),
--           nem nenhum outro marcador ([CURSO:slug], [VIDEO:id], [LISTA_CURSOS] etc).

BEGIN;

-- Bloco a remover (exato, com newlines E'\n...'):
-- O regexp_replace remove o bloco desde '\n\n[SOBRE OS CURSOS]\n' ate a linha
-- vazia que o segue (antes do proximo bloco), usando mode 'g' para seguranca.
-- Compativel com Postgres 16 regexp_replace com flags.

-- 1. Matriz teste_vendas_barbearia
UPDATE bot_prompt
SET
  prompt = regexp_replace(
    prompt,
    E'\n\n\[SOBRE OS CURSOS\]\nDuracao: 3 meses \| 2x por semana\nHorarios: Manha 09h-11h \| Tarde 15h-17h\nInclui: Apostila completa, fardamento e suporte no grupo de WhatsApp\nDiploma valido em mais de 122 paises - trabalha em qualquer lugar do Brasil\nCurso pratico, do zero ao profissional',
    '',
    'g'
  ),
  updated_at = NOW()
WHERE slot = 'teste_vendas_barbearia'
  AND prompt LIKE '%[SOBRE OS CURSOS]%'
  AND prompt NOT LIKE '%[INSTRUCAO SOBRE CURSOS]%';

-- 2. Clone do Ricardo
UPDATE bot_prompt
SET
  prompt = regexp_replace(
    prompt,
    E'\n\n\[SOBRE OS CURSOS\]\nDuracao: 3 meses \| 2x por semana\nHorarios: Manha 09h-11h \| Tarde 15h-17h\nInclui: Apostila completa, fardamento e suporte no grupo de WhatsApp\nDiploma valido em mais de 122 paises - trabalha em qualquer lugar do Brasil\nCurso pratico, do zero ao profissional',
    '',
    'g'
  ),
  updated_at = NOW()
WHERE slot = 'clone_ricardo_curso_barbearia_qcl1eb'
  AND prompt LIKE '%[SOBRE OS CURSOS]%'
  AND prompt NOT LIKE '%[INSTRUCAO SOBRE CURSOS]%';

-- 3. Adiciona [INSTRUCAO SOBRE CURSOS] antes de [MARCADORES DE ACAO] na matriz.
--    Garante que a IA saiba usar [CURSOS DISPONIVEIS] do contexto como unica fonte.
UPDATE bot_prompt
SET
  prompt = replace(
    prompt,
    E'[MARCADORES DE ACAO - REGRAS CRITICAS]',
    E'[INSTRUCAO SOBRE CURSOS]\nUse APENAS os dados em [CURSOS DISPONIVEIS] do contexto como fonte de informacao sobre cursos.\nNAO invente preco, duracao, certificado, modalidade ou qualquer detalhe nao listado la.\nSe o cliente perguntar algo que nao esta em [CURSOS DISPONIVEIS], diga que vai pedir ao responsavel para confirmar.\n\n[MARCADORES DE ACAO - REGRAS CRITICAS]'
  ),
  updated_at = NOW()
WHERE slot = 'teste_vendas_barbearia'
  AND prompt NOT LIKE '%[INSTRUCAO SOBRE CURSOS]%'
  AND prompt LIKE '%[MARCADORES DE ACAO - REGRAS CRITICAS]%';

-- 4. Adiciona [INSTRUCAO SOBRE CURSOS] no clone do Ricardo.
UPDATE bot_prompt
SET
  prompt = replace(
    prompt,
    E'[MARCADORES DE ACAO - REGRAS CRITICAS]',
    E'[INSTRUCAO SOBRE CURSOS]\nUse APENAS os dados em [CURSOS DISPONIVEIS] do contexto como fonte de informacao sobre cursos.\nNAO invente preco, duracao, certificado, modalidade ou qualquer detalhe nao listado la.\nSe o cliente perguntar algo que nao esta em [CURSOS DISPONIVEIS], diga que vai pedir ao Ricardo para confirmar.\n\n[MARCADORES DE ACAO - REGRAS CRITICAS]'
  ),
  updated_at = NOW()
WHERE slot = 'clone_ricardo_curso_barbearia_qcl1eb'
  AND prompt NOT LIKE '%[INSTRUCAO SOBRE CURSOS]%'
  AND prompt LIKE '%[MARCADORES DE ACAO - REGRAS CRITICAS]%';

COMMIT;
