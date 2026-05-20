-- Migration 029: seed de 4 servicos default para clones da matriz teste_barbearia
-- que ainda nao tem servicos cadastrados (array vazio ou NULL).
--
-- Bruno decidiu (2026-05-20) que clones de barbearia ja nascem com 4 servicos
-- comuns preenchidos. Cliente edita pelo painel quando precisar — agora
-- o bot ja oferece servicos faceis (Corte, Barba, Sobrancelha, Pezinho) ao
-- inves de "Nenhum servico cadastrado".
--
-- Valor padrao: R$50,00 (5000 centavos), 30 minutos cada.
-- Idempotente: so aplica onde nao tem servicos preenchidos.

BEGIN;

UPDATE flow_clones
SET servicos = '[
  {"nome": "Corte", "preco_cents": 5000, "duracao_min": 30},
  {"nome": "Barba", "preco_cents": 5000, "duracao_min": 30},
  {"nome": "Sobrancelha", "preco_cents": 5000, "duracao_min": 30},
  {"nome": "Pezinho", "preco_cents": 5000, "duracao_min": 30}
]'::jsonb,
    updated_at = NOW()
WHERE matriz_slot = 'teste_barbearia'
  AND (servicos IS NULL OR servicos = '[]'::jsonb);

COMMIT;
