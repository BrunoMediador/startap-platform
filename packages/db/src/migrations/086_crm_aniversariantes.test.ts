/**
 * Guarda estática da migration 086 (CRM aniversariantes read-only). Invariantes:
 * índice aditivo por slot+tenant+aniversário para a listagem read-only, sem
 * backfill nem mutação em `atendimentos`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/086_crm_aniversariantes.sql', import.meta.url)),
  'utf8',
);
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 086 — crm aniversariantes', () => {
  it('cria índice aditivo por slot+tenant+aniversario_mmdd', () => {
    expect(SQL).toMatch(/ix_clientes_aniversario_mmdd/i);
    expect(SQL).toMatch(/ON clientes \(slot, tenant_id, aniversario_mmdd, id\)/i);
    expect(SQL).toMatch(/WHERE aniversario_mmdd IS NOT NULL/i);
  });

  it('permanece aditiva e sem comandos destrutivos executáveis', () => {
    expect(SQL).toMatch(/\bBEGIN\b/);
    expect(SQL).toMatch(/\bCOMMIT\b/);
    expect(SQL_STMTS).not.toMatch(/^\s*DROP\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*DELETE\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*TRUNCATE\b/im);
  });
});
