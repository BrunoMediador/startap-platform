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

  it('reusa os índices elegíveis da migration 085 sem criar duplicata invertida', () => {
    expect(SQL).toMatch(/índices parciais de atendimento elegível já existem na migration 085/i);
    expect(SQL).not.toMatch(/ix_atendimentos_cliente_crm_lista_(agenda|manual)/i);
  });
});
