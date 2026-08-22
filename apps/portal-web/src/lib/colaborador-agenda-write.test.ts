import { describe, expect, it } from 'vitest';
import { podeGerenciarAgendaColaborador } from './colaborador-agenda-write';

describe('podeGerenciarAgendaColaborador', () => {
  it('falha fechado quando o contrato ainda não expõe a capability', () => {
    expect(podeGerenciarAgendaColaborador({})).toBe(false);
  });

  it('só libera escrita para true explícito do servidor', () => {
    expect(podeGerenciarAgendaColaborador({ agenda_write_enabled: false })).toBe(false);
    expect(podeGerenciarAgendaColaborador({ agenda_write_enabled: true })).toBe(true);
  });
});
