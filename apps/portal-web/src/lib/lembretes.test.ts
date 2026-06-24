import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import type { LembretesConfig } from './api-types';
import {
  DEFAULT_WINDOWS,
  type JanelaMin,
  type LembretesDraft,
  isJanelaPermitida,
  isLembretesDirty,
  isLembretesFeatureOff,
  isLembretesValido,
  normalizeWindows,
  setEnabled,
  toLembretesDraft,
  toLembretesPatch,
  toggleWindow,
} from './lembretes';

function draft(over: Partial<LembretesDraft>): LembretesDraft {
  return { enabled: false, windows: [], ...over };
}

describe('isJanelaPermitida', () => {
  it('só aceita 1440, 180, 120 e 60', () => {
    expect(isJanelaPermitida(1440)).toBe(true);
    expect(isJanelaPermitida(180)).toBe(true);
    expect(isJanelaPermitida(120)).toBe(true);
    expect(isJanelaPermitida(60)).toBe(true);
    expect(isJanelaPermitida(30)).toBe(false);
    expect(isJanelaPermitida(0)).toBe(false);
    expect(isJanelaPermitida(99999)).toBe(false);
  });
});

describe('normalizeWindows', () => {
  it('descarta janelas não permitidas', () => {
    expect(normalizeWindows([1440, 30, 120, 5])).toEqual([1440, 120]);
  });

  it('deduplica', () => {
    expect(normalizeWindows([120, 120, 1440, 1440])).toEqual([1440, 120]);
  });

  it('ordena DESC (mais distante primeiro), independente da ordem de entrada', () => {
    expect(normalizeWindows([60, 1440, 120, 180])).toEqual([1440, 180, 120, 60]);
  });

  it('trata null/undefined/vazio como lista vazia', () => {
    expect(normalizeWindows(null)).toEqual([]);
    expect(normalizeWindows(undefined)).toEqual([]);
    expect(normalizeWindows([])).toEqual([]);
  });
});

describe('toLembretesDraft', () => {
  it('mapeia a resposta do backend pra draft normalizado', () => {
    const data: LembretesConfig = { enabled: true, windows_min: [120, 1440] };
    expect(toLembretesDraft(data)).toEqual({ enabled: true, windows: [1440, 120] });
  });

  it('default seguro quando vem null/ausente', () => {
    expect(toLembretesDraft(null)).toEqual({ enabled: false, windows: [] });
    expect(toLembretesDraft(undefined)).toEqual({ enabled: false, windows: [] });
  });

  it('coage enabled não-booleano pra false e filtra janelas inválidas', () => {
    const sujo = { enabled: 1, windows_min: [120, 7] } as unknown as LembretesConfig;
    expect(toLembretesDraft(sujo)).toEqual({ enabled: false, windows: [120] });
  });
});

describe('toggleWindow', () => {
  it('adiciona mantendo a ordem canônica DESC', () => {
    const d = draft({ enabled: true, windows: [60] });
    expect(toggleWindow(d, 1440).windows).toEqual([1440, 60]);
  });

  it('remove uma janela já marcada', () => {
    const d = draft({ enabled: true, windows: [1440, 120] });
    expect(toggleWindow(d, 1440).windows).toEqual([120]);
  });

  it('preserva enabled', () => {
    const d = draft({ enabled: true, windows: [120] });
    expect(toggleWindow(d, 60).enabled).toBe(true);
  });
});

describe('setEnabled', () => {
  it('ligar sem nenhuma janela semeia o default (24h + 2h)', () => {
    const res = setEnabled(draft({ enabled: false, windows: [] }), true);
    expect(res).toEqual({ enabled: true, windows: DEFAULT_WINDOWS });
  });

  it('ligar com janelas já escolhidas não mexe nas janelas', () => {
    const res = setEnabled(draft({ enabled: false, windows: [180] }), true);
    expect(res).toEqual({ enabled: true, windows: [180] });
  });

  it('desligar preserva as janelas escolhidas', () => {
    const res = setEnabled(draft({ enabled: true, windows: [1440, 60] }), false);
    expect(res).toEqual({ enabled: false, windows: [1440, 60] });
  });
});

describe('isLembretesDirty', () => {
  it('detecta mudança no enabled', () => {
    expect(isLembretesDirty(draft({ enabled: true }), draft({ enabled: false }))).toBe(true);
  });

  it('detecta mudança nas janelas', () => {
    expect(
      isLembretesDirty(
        draft({ enabled: true, windows: [1440] }),
        draft({ enabled: true, windows: [1440, 120] }),
      ),
    ).toBe(true);
  });

  it('iguais (mesmo enabled e mesmas janelas) = não-dirty', () => {
    expect(
      isLembretesDirty(
        draft({ enabled: true, windows: [1440, 120] }),
        draft({ enabled: true, windows: [1440, 120] }),
      ),
    ).toBe(false);
  });
});

describe('isLembretesValido', () => {
  it('desligado é sempre válido (janelas ignoradas)', () => {
    expect(isLembretesValido(draft({ enabled: false, windows: [] }))).toBe(true);
  });

  it('ligado sem janela é inválido', () => {
    expect(isLembretesValido(draft({ enabled: true, windows: [] }))).toBe(false);
  });

  it('ligado com pelo menos uma janela é válido', () => {
    expect(isLembretesValido(draft({ enabled: true, windows: [60] }))).toBe(true);
  });
});

describe('toLembretesPatch', () => {
  it('manda enabled + windows_min (estado completo)', () => {
    const d = draft({ enabled: true, windows: [1440, 120] });
    expect(toLembretesPatch(d)).toEqual({ enabled: true, windows_min: [1440, 120] });
  });

  it('desligado ainda manda as janelas pra preservá-las no servidor', () => {
    const d = draft({ enabled: false, windows: [180] });
    expect(toLembretesPatch(d)).toEqual({ enabled: false, windows_min: [180] });
  });

  it('o array do patch é uma cópia (não vaza referência do draft)', () => {
    const d = draft({ enabled: true, windows: [60] });
    const patch = toLembretesPatch(d);
    patch.windows_min.push(999 as JanelaMin);
    expect(d.windows).toEqual([60]);
  });
});

describe('isLembretesFeatureOff', () => {
  it('404 = feature desligada (REMINDERS_ENABLED OFF) -> seção some', () => {
    const err = new ApiError(404, 'Not Found', null);
    expect(isLembretesFeatureOff(err)).toBe(true);
  });

  it('500 / outros status NÃO são feature-off (mostra erro real)', () => {
    expect(isLembretesFeatureOff(new ApiError(500, 'Internal', null))).toBe(false);
    expect(isLembretesFeatureOff(new ApiError(401, 'Unauthorized', null))).toBe(false);
    expect(isLembretesFeatureOff(new ApiError(0, 'Network', null))).toBe(false);
  });

  it('erro genérico / null / undefined NÃO são feature-off', () => {
    expect(isLembretesFeatureOff(new Error('boom'))).toBe(false);
    expect(isLembretesFeatureOff(null)).toBe(false);
    expect(isLembretesFeatureOff(undefined)).toBe(false);
  });
});
