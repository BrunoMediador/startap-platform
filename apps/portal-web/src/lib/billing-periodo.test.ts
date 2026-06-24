import { describe, expect, it } from 'vitest';
import { periodoLimites, periodoPadrao, periodoPresets } from './billing-periodo';

// Fixa "hoje" = 2026-06-23 (terça) pra os cálculos serem determinísticos.
const NOW = new Date(2026, 5, 23, 10, 0, 0); // mês 5 = junho (0-based)

describe('periodoPadrao', () => {
  it('faturado olha o passado: 1º do mês até hoje', () => {
    expect(periodoPadrao('faturado', NOW)).toEqual({ de: '2026-06-01', ate: '2026-06-23' });
  });

  it('previsao olha o futuro: hoje até hoje+30 dias', () => {
    expect(periodoPadrao('previsao', NOW)).toEqual({ de: '2026-06-23', ate: '2026-07-23' });
  });

  it('previsao NUNCA nasce só no passado (de >= hoje) — é o coração do fix do bug', () => {
    const p = periodoPadrao('previsao', NOW);
    expect(p.de >= '2026-06-23').toBe(true);
    expect(p.ate > '2026-06-23').toBe(true);
  });
});

describe('periodoLimites', () => {
  it('faturado: trava o "ate" em hoje (não há faturado no futuro)', () => {
    const lim = periodoLimites('faturado', { de: '2026-06-01', ate: '2026-06-23' }, NOW);
    expect(lim.ate.max).toBe('2026-06-23');
    expect(lim.de.max).toBe('2026-06-23'); // de não passa do ate
  });

  it('previsao: LIBERA datas futuras — o "ate" NÃO tem teto em hoje (o fix)', () => {
    const lim = periodoLimites('previsao', { de: '2026-06-23', ate: '2026-07-23' }, NOW);
    expect(lim.ate.max).toBeUndefined(); // sem max=hoje => calendário não trava no futuro
    expect(lim.de.min).toBe('2026-06-23'); // previsão é daqui pra frente
  });

  it('previsao: de <= ate (janela coerente) via de.max = ate', () => {
    const lim = periodoLimites('previsao', { de: '2026-06-23', ate: '2026-07-10' }, NOW);
    expect(lim.de.max).toBe('2026-07-10');
    expect(lim.ate.min).toBe('2026-06-23');
  });
});

describe('periodoPresets', () => {
  it('faturado: presets do passado (Este mês / Mês passado / Hoje)', () => {
    const ps = periodoPresets('faturado', NOW);
    expect(ps.map((p) => p.label)).toEqual(['Este mês', 'Mês passado', 'Hoje']);
    expect(ps[0].value).toEqual({ de: '2026-06-01', ate: '2026-06-23' });
    expect(ps[1].value).toEqual({ de: '2026-05-01', ate: '2026-05-31' });
  });

  it('previsao: presets do futuro (Hoje / Próx. 7 / Próx. 30) — todos começam hoje', () => {
    const ps = periodoPresets('previsao', NOW);
    expect(ps.map((p) => p.label)).toEqual(['Hoje', 'Próx. 7 dias', 'Próx. 30 dias']);
    for (const p of ps) expect(p.value.de).toBe('2026-06-23');
    expect(ps[1].value.ate).toBe('2026-06-30');
    expect(ps[2].value.ate).toBe('2026-07-23');
  });

  it('previsao: nenhum preset aponta pro passado', () => {
    for (const p of periodoPresets('previsao', NOW)) {
      expect(p.value.ate >= '2026-06-23').toBe(true);
    }
  });
});
