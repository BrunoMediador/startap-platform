-- Migration 014: adiciona coluna slot nas tabelas de leads para isolamento por clone
-- Idempotente. Sem DROP/DELETE/TRUNCATE.

BEGIN;

-- leads_ricardo (matriz: teste_vendas)
ALTER TABLE leads_ricardo ADD COLUMN IF NOT EXISTS slot VARCHAR(80);
CREATE INDEX IF NOT EXISTS idx_leads_ricardo_slot ON leads_ricardo(slot);
UPDATE leads_ricardo SET slot = 'teste_vendas' WHERE slot IS NULL;

-- leads_vendas_barbearia (matriz: teste_vendas_barbearia)
ALTER TABLE leads_vendas_barbearia ADD COLUMN IF NOT EXISTS slot VARCHAR(80);
CREATE INDEX IF NOT EXISTS idx_leads_vendas_barbearia_slot ON leads_vendas_barbearia(slot);
UPDATE leads_vendas_barbearia SET slot = 'teste_vendas_barbearia' WHERE slot IS NULL;

COMMIT;
