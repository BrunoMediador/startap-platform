/**
 * Testes da lógica PURA do lembrete (core/reminders). Sem I/O — só funções determinísticas:
 *  - validateWindows: conjunto permitido, dedup, ordena desc, rejeita vazio/lixo/duplicado-só.
 *  - resolveWindows: NULL/[] -> default global; configurado válido -> ele mesmo.
 *  - isWindowDue / minutesUntil: dispara no tempo certo (dentro da tolerância), não antes/depois.
 *  - formatHorarioBRT: render em America/Sao_Paulo (UTC-3).
 *  - renderReminderTemplate: vars, SOLO omite {profissional}, estabelecimento nomeia, limpeza.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_REMINDER_WINDOWS_MIN,
  DEFAULT_REMINDER_TEMPLATE,
  DEFAULT_REMINDER_WINDOWS_MIN,
  formatHorarioBRT,
  isWindowDue,
  minutesUntil,
  renderReminderTemplate,
  resolveWindows,
  validateWindows,
} from './reminders.js';

describe('validateWindows', () => {
  it('aceita o conjunto permitido e ordena desc', () => {
    const v = validateWindows([120, 1440]);
    expect(v).toEqual({ ok: true, windows: [1440, 120] });
  });

  it('deduplica valores repetidos', () => {
    const v = validateWindows([120, 120, 60]);
    expect(v).toEqual({ ok: true, windows: [120, 60] });
  });

  it('aceita "120" string coercível (do JSON do front)', () => {
    const v = validateWindows([120 as unknown]);
    expect(v.ok).toBe(true);
  });

  it('rejeita valor fora do conjunto permitido (90)', () => {
    expect(validateWindows([90])).toEqual({ ok: false, reason: 'invalid_value' });
  });

  it('rejeita não-array', () => {
    expect(validateWindows('x')).toEqual({ ok: false, reason: 'not_array' });
  });

  it('rejeita vazio', () => {
    expect(validateWindows([])).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejeita lista maior que o conjunto permitido', () => {
    expect(validateWindows([1440, 180, 120, 60, 1440])).not.toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it('o conjunto permitido tem 1440/180/120/60', () => {
    expect([...ALLOWED_REMINDER_WINDOWS_MIN].sort((a, b) => b - a)).toEqual([1440, 180, 120, 60]);
  });
});

describe('resolveWindows', () => {
  it('NULL -> default global', () => {
    expect(resolveWindows(null)).toEqual([...DEFAULT_REMINDER_WINDOWS_MIN]);
  });
  it('[] -> default global', () => {
    expect(resolveWindows([])).toEqual([...DEFAULT_REMINDER_WINDOWS_MIN]);
  });
  it('configurado válido -> ordenado desc', () => {
    expect(resolveWindows([60, 1440])).toEqual([1440, 60]);
  });
  it('configurado com lixo -> cai no default', () => {
    expect(resolveWindows([99])).toEqual([...DEFAULT_REMINDER_WINDOWS_MIN]);
  });
});

describe('minutesUntil / isWindowDue (janela dispara no tempo certo)', () => {
  const now = new Date('2026-06-24T12:00:00Z');

  it('minutesUntil positivo no futuro, negativo no passado', () => {
    expect(minutesUntil(new Date('2026-06-24T14:00:00Z'), now)).toBe(120);
    expect(minutesUntil(new Date('2026-06-24T11:00:00Z'), now)).toBe(-60);
  });

  it('janela 120: dispara quando faltam exatamente 120 min', () => {
    expect(isWindowDue(120, 120, 6)).toBe(true);
  });

  it('janela 120: dispara quando faltam 116 min (dentro da tolerância 6)', () => {
    expect(isWindowDue(120, 116, 6)).toBe(true);
  });

  it('janela 120: NÃO dispara quando faltam 130 min (cedo demais)', () => {
    expect(isWindowDue(120, 130, 6)).toBe(false);
  });

  it('janela 120: NÃO dispara quando faltam 110 min (já passou da janela)', () => {
    expect(isWindowDue(120, 110, 6)).toBe(false);
  });

  it('janela 1440 (24h): dispara faltando 1438 min', () => {
    expect(isWindowDue(1440, 1438, 6)).toBe(true);
  });
});

describe('formatHorarioBRT (America/Sao_Paulo, UTC-3)', () => {
  it('13:30Z -> 10:30 BRT', () => {
    expect(formatHorarioBRT(new Date('2026-06-24T13:30:00Z'))).toBe('24/06 às 10:30');
  });

  it('vira o dia pra trás na conversão BRT (02:00Z -> 23:00 do dia anterior)', () => {
    expect(formatHorarioBRT(new Date('2026-06-24T02:00:00Z'))).toBe('23/06 às 23:00');
  });
});

describe('renderReminderTemplate', () => {
  const inicioAt = new Date('2026-06-24T13:30:00Z'); // 10:30 BRT

  it('estabelecimento: nomeia o profissional certo', () => {
    const txt = renderReminderTemplate({
      clienteNome: 'João',
      servicoNome: 'Corte',
      inicioAt,
      profissionalNome: 'Eduardo',
      negocio: 'Barber Dragon',
    });
    expect(txt).toContain('com Eduardo');
    expect(txt).toContain('Corte');
    expect(txt).toContain('24/06 às 10:30');
    expect(txt).toContain('Barber Dragon');
    expect(txt).toContain('João');
  });

  it('SOLO/individual: OMITE o profissional (sem "com")', () => {
    const txt = renderReminderTemplate({
      clienteNome: 'Maria',
      servicoNome: 'Corte',
      inicioAt,
      profissionalNome: null,
      negocio: 'Cirilo Barbearia',
    });
    expect(txt).not.toContain('com ');
    expect(txt).toContain('Cirilo Barbearia');
  });

  it('cliente sem nome: não deixa vírgula/espaço solto', () => {
    const txt = renderReminderTemplate({
      clienteNome: null,
      servicoNome: 'Barba',
      inicioAt,
      profissionalNome: null,
      negocio: 'Salão X',
    });
    expect(txt).not.toMatch(/ {2,}/);
    expect(txt).not.toMatch(/Oi,/); // sem "Oi," quando não há nome
    expect(txt).toContain('Oi!');
  });

  it('usa o template do clone quando setado', () => {
    const txt = renderReminderTemplate({
      clienteNome: 'Ana',
      servicoNome: 'Corte',
      inicioAt,
      profissionalNome: null,
      negocio: 'Z',
      template: 'Lembrete: {horario}. Até!',
    });
    expect(txt).toBe('Lembrete: 24/06 às 10:30. Até!');
  });

  it('template vazio cai no default', () => {
    const txt = renderReminderTemplate({
      inicioAt,
      negocio: 'N',
      template: '   ',
    });
    expect(txt).toContain('24/06 às 10:30');
    expect(txt).toContain('N');
  });

  it('o template default contém todas as vars (sanidade da COPY)', () => {
    for (const v of [
      '{cliente_nome}',
      '{servico_nome}',
      '{horario}',
      '{profissional}',
      '{negocio}',
    ]) {
      expect(DEFAULT_REMINDER_TEMPLATE).toContain(v);
    }
  });
});
