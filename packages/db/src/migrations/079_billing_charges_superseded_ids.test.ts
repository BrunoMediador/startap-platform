/**
 * Guarda estática da migration 079 (SCRUM-141). Segurança = conteúdo do SQL (sem DB neste
 * unit). Invariantes: aditiva/reversível (ADD COLUMN IF NOT EXISTS, sem DROP/DELETE/TRUNCATE
 * nos statements executáveis), coluna NOT NULL DEFAULT '{}' (nunca NULL pra linha existente).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(
    new URL('../../migrations/079_billing_charges_superseded_ids.sql', import.meta.url),
  ),
  'utf8',
);
// Guard "sem DROP/DELETE/TRUNCATE" vale pros STATEMENTS, não pra menção em comentário
// (o comentário de rollback cita DROP de propósito).
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 079 — billing_charges.superseded_charge_ids', () => {
  it('adiciona a coluna de forma idempotente (ADD COLUMN IF NOT EXISTS)', () => {
    expect(SQL).toMatch(
      /ALTER TABLE billing_charges\s+ADD COLUMN IF NOT EXISTS superseded_charge_ids\b/i,
    );
  });

  it("coluna é TEXT[] NOT NULL DEFAULT '{}' (nunca NULL, seguro com a flag OFF)", () => {
    expect(SQL).toMatch(/superseded_charge_ids TEXT\[\] NOT NULL DEFAULT '\{\}'/i);
  });

  it('é ADITIVA e REVERSÍVEL: sem DROP/DELETE/TRUNCATE nos statements (regra de ouro)', () => {
    expect(SQL_STMTS).not.toMatch(/\bDROP\b/i);
    expect(SQL_STMTS).not.toMatch(/\bDELETE\b/i);
    expect(SQL_STMTS).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('é transacional (BEGIN/COMMIT)', () => {
    expect(SQL).toMatch(/\bBEGIN\b/);
    expect(SQL).toMatch(/\bCOMMIT\b/);
  });
});
