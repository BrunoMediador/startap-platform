import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/088_crm_clientes_evolucao.sql', import.meta.url)),
  'utf8',
);
const statements = SQL.replace(/--[^\n]*/g, '');

describe('migration 088 — evolução CRM Clientes', () => {
  it('é aditiva e preserva nome de origem separado da personalização', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS nome_personalizado TEXT/i);
    expect(SQL).toMatch(/clientes_nome_personalizado_chk/i);
    expect(SQL).toMatch(/char_length\(btrim\(nome_personalizado\)\) BETWEEN 1 AND 120/i);
    expect(statements).not.toMatch(/^\s*(DROP|DELETE|TRUNCATE)\b/im);
  });

  it('cria índices parciais por slot e tenant para as duas fontes elegíveis', () => {
    expect(SQL).toMatch(/ix_atendimentos_cliente_crm_lista_agenda/i);
    expect(SQL).toMatch(/ix_atendimentos_cliente_crm_lista_manual/i);
    expect(SQL).toMatch(/deleted_at IS NULL\s+AND status <> 'cancelado'/i);
    expect(SQL).toMatch(/ON atendimentos \(slot, tenant_id, cliente_telefone_canonico/i);
  });
});
