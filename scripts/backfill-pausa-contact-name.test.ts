/**
 * Unit do predicado do backfill de contact_name (SCRUM-144). Mocka @startap/db e
 * @startap/core/phone só pra o import do script não instanciar pool/pg — o alvo é a função
 * pura isBackfillableName (o guard invokedDirectly impede o main() de rodar em teste).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@startap/db', () => ({ query: vi.fn(), closePool: vi.fn() }));
vi.mock('@startap/core/phone', () => ({
  canonicalE164: () => null,
  phoneHint: () => '',
}));

const { isBackfillableName } = await import('./backfill-pausa-contact-name.js');

describe('isBackfillableName — só migra nome REAL', () => {
  it('true pra nome real (incl. com espaços a aparar)', () => {
    expect(isBackfillableName('Wal Delfim')).toBe(true);
    expect(isBackfillableName('  Ed+  ')).toBe(true);
  });

  it('false pra null/undefined/vazio/só-espaços (não-vácuo)', () => {
    expect(isBackfillableName(null)).toBe(false);
    expect(isBackfillableName(undefined)).toBe(false);
    expect(isBackfillableName('')).toBe(false);
    expect(isBackfillableName('   ')).toBe(false);
  });

  it('false pro literal BOT_DETECTADO em qualquer caixa/espaço', () => {
    expect(isBackfillableName('BOT_DETECTADO')).toBe(false);
    expect(isBackfillableName('bot_detectado')).toBe(false);
    expect(isBackfillableName(' BOT_DETECTADO ')).toBe(false);
  });
});
