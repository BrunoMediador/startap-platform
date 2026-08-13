import { describe, expect, it } from 'vitest';
import {
  LANDING_CTAS,
  LANDING_SCENARIOS,
  getLandingScenario,
  isLandingScenarioId,
} from './landing-content';

describe('landing scenarios', () => {
  it('mantém os três cenários seguros, identificáveis e com conteúdo completo', () => {
    expect(LANDING_SCENARIOS.map((scenario) => scenario.id)).toEqual(['agenda', 'audio', 'human']);
    expect(new Set(LANDING_SCENARIOS.map((scenario) => scenario.id)).size).toBe(3);

    for (const scenario of LANDING_SCENARIOS) {
      expect(isLandingScenarioId(scenario.id)).toBe(true);
      expect(getLandingScenario(scenario.id)).toBe(scenario);
      expect(scenario.messages.length).toBeGreaterThanOrEqual(4);
      expect(scenario.messages.some((message) => message.role === 'customer')).toBe(true);
      expect(scenario.messages.every((message) => !/[<>]/.test(message.text))).toBe(true);
      expect(scenario.eventTitle).not.toBe('');
      expect(scenario.controlTitle).not.toBe('');
    }

    expect(isLandingScenarioId('desconhecido')).toBe(false);
  });
});

describe('landing CTAs', () => {
  it('leva aquisição e acesso apenas às rotas públicas reais', () => {
    expect(LANDING_CTAS.primary.href).toBe('/cadastro');
    expect(LANDING_CTAS.final.href).toBe('/cadastro');
    expect(LANDING_CTAS.login.href).toBe('/login');
    expect(Object.values(LANDING_CTAS).every((cta) => cta.href.startsWith('/'))).toBe(true);
  });
});
