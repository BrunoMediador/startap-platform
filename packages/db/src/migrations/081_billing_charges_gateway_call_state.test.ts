/**
 * Guarda estática da migration 081 (SCRUM-173). Segurança = conteúdo do SQL (sem DB neste
 * unit). Invariantes: aditiva/reversível (ADD COLUMN IF NOT EXISTS, sem DROP/DELETE/TRUNCATE
 * nos statements executáveis), colunas retrocompatíveis (DEFAULT 'idle' cobre linha
 * existente e código velho), CHECK idempotente sem DROP CONSTRAINT.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(
    new URL('../../migrations/081_billing_charges_gateway_call_state.sql', import.meta.url),
  ),
  'utf8',
);
// Guard "sem DROP/DELETE/TRUNCATE" vale pros STATEMENTS, não pra menção em comentário
// (o comentário de rollback cita DROP de propósito).
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 081 — billing_charges.gateway_call_state (outbox SCRUM-173)', () => {
  it('adiciona as duas colunas de forma idempotente (ADD COLUMN IF NOT EXISTS)', () => {
    expect(SQL).toMatch(
      /ALTER TABLE billing_charges\s+ADD COLUMN IF NOT EXISTS gateway_call_state\b/i,
    );
    expect(SQL).toMatch(
      /ALTER TABLE billing_charges\s+ADD COLUMN IF NOT EXISTS gateway_call_started_at\b/i,
    );
  });

  it("gateway_call_state e TEXT NOT NULL DEFAULT 'idle' (retrocompatível: linha existente e codigo velho nunca ficam bloqueados)", () => {
    expect(SQL).toMatch(/gateway_call_state TEXT NOT NULL DEFAULT 'idle'/i);
  });

  it('gateway_call_started_at e nullable (sem timestamp -> claimGatewayCall trata como livre pra reivindicar)', () => {
    expect(SQL).toMatch(/gateway_call_started_at TIMESTAMPTZ;/i);
    expect(SQL).not.toMatch(/gateway_call_started_at TIMESTAMPTZ NOT NULL/i);
  });

  it('CHECK de dominio e idempotente via pg_constraint (sem DROP CONSTRAINT)', () => {
    expect(SQL).toMatch(/CHECK \(gateway_call_state IN \('idle', 'calling', 'done'\)\)/);
    expect(SQL).toMatch(
      /SELECT 1 FROM pg_constraint WHERE conname = 'billing_charges_gateway_call_state_check'/,
    );
    expect(SQL_STMTS).not.toMatch(/DROP CONSTRAINT/i);
  });

  it('é ADITIVA e REVERSÍVEL: sem DROP/DELETE/TRUNCATE nos statements executáveis (regra de ouro)', () => {
    expect(SQL_STMTS).not.toMatch(/\bDROP\b/i);
    expect(SQL_STMTS).not.toMatch(/\bDELETE\b/i);
    expect(SQL_STMTS).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('documenta o rollback (DROP COLUMN) so em comentario, nunca em statement executavel', () => {
    expect(SQL).toMatch(/DROP COLUMN IF EXISTS gateway_call_state/);
    expect(SQL).toMatch(/DROP COLUMN IF EXISTS gateway_call_started_at/);
  });

  it('é transacional (BEGIN/COMMIT)', () => {
    expect(SQL).toMatch(/\bBEGIN\b/);
    expect(SQL).toMatch(/\bCOMMIT\b/);
  });
});
