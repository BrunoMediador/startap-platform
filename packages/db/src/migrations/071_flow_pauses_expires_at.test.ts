/**
 * Guarda estática da migration 071 (SCRUM-59). Segurança = conteúdo do SQL (não há DB
 * neste unit). Invariantes: aditiva/reversível (ADD COLUMN IF NOT EXISTS, sem DROP/DELETE/
 * TRUNCATE), seed idempotente (ON CONFLICT DO NOTHING) só do slot-piloto Meduzza, e o
 * keyword_norm do seed bate com a normalização canônica.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizePauseKeyword } from '@startap/core/pause-keyword';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/071_flow_pauses_expires_at.sql', import.meta.url)),
  'utf8',
);
// SQL sem comentários: o guard "sem DROP/DELETE/TRUNCATE" vale pros STATEMENTS executáveis,
// não pra menção em comentário (o comentário de rollback cita DROP de propósito).
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 071 — flow_pauses.expires_at + seed Meduzza', () => {
  it('adiciona expires_at de forma idempotente (ADD COLUMN IF NOT EXISTS)', () => {
    expect(SQL).toMatch(/ALTER TABLE flow_pauses ADD COLUMN IF NOT EXISTS expires_at\b/i);
  });

  it('cria índice parcial das pausas com validade (idempotente)', () => {
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_flow_pauses_expires_at/i);
  });

  it('é ADITIVA e REVERSÍVEL: sem DROP/DELETE/TRUNCATE nos statements (regra de ouro)', () => {
    expect(SQL_STMTS).not.toMatch(/\bDROP\b/i);
    expect(SQL_STMTS).not.toMatch(/\bDELETE\b/i);
    expect(SQL_STMTS).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('seed idempotente das frases só do slot-piloto Meduzza (ON CONFLICT DO NOTHING)', () => {
    expect(SQL).toContain('clone_meduzza_barbearia_q23psc');
    expect(SQL).toMatch(/INSERT INTO flow_pause_keywords/i);
    expect(SQL).toMatch(/ON CONFLICT \(flow_id, command, keyword_norm\) DO NOTHING/i);
  });

  it('keyword_norm do seed = normalização canônica das frases', () => {
    expect(SQL).toContain(normalizePauseKeyword('atendente aqui!!')); // atendenteaqui!!
    expect(SQL).toContain(normalizePauseKeyword('assistente voltar!!')); // assistentevoltar!!
  });
});
