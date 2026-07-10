import { describe, expect, it } from 'vitest';
import { agendaConexaoEstado } from './agenda-conexao';

describe('agendaConexaoEstado', () => {
  it('agenda ligada -> conectada (gcal_configured vence, independente de aguardando)', () => {
    expect(agendaConexaoEstado({ gcal_configured: true })).toBe('conectada');
    // Precedência: assim que a equipe conecta, o card "aguardando" some sozinho.
    expect(agendaConexaoEstado({ gcal_configured: true, aguardando_agenda: true })).toBe(
      'conectada',
    );
  });

  it('escolheu agenda e a equipe ainda está conectando -> aguardando (mostra o card com SLA)', () => {
    expect(agendaConexaoEstado({ gcal_configured: false, aguardando_agenda: true })).toBe(
      'aguardando',
    );
  });

  it('gcal off SEM aguardando -> nao-conectada (empty genérico de hoje, byte-idêntico)', () => {
    // Modo atendente (nunca terá agenda).
    expect(agendaConexaoEstado({ gcal_configured: false, aguardando_agenda: false })).toBe(
      'nao-conectada',
    );
    // Contrato antigo do backend, sem o campo -> cai no comportamento atual.
    expect(agendaConexaoEstado({ gcal_configured: false })).toBe('nao-conectada');
  });
});
