import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(
    new URL('../../migrations/094_flow_clones_confirmation_card_contract.sql', import.meta.url),
  ),
  'utf8',
);
const statements = SQL.replace(/--[^\n]*/g, '');

describe('migration 094 — contrato estruturado do cartão', () => {
  it('é aditiva, nula por padrão e não muda configuração de nenhum slot', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS confirmation_card_contract JSONB/i);
    expect(SQL).toMatch(/NULL mantém cada clone/i);
    expect(statements).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|DROP|TRUNCATE)\b/im);
    expect(statements).not.toMatch(/\b(telefone|phone|cliente_nome|mensagem|message)\b/i);
  });
});
