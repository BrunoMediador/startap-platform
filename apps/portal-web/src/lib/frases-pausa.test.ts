import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import type { FrasePausa } from './api-types';
import {
  type FrasePausaDraft,
  MAX_FRASES,
  addFrase,
  atMaxFrases,
  isFrasesDirty,
  isFrasesFeatureOff,
  isFrasesRejeitadas,
  isFrasesValidas,
  newFraseId,
  normalizeKeyword,
  removeFrase,
  setFraseCommand,
  setFraseKeyword,
  toFrasesDraft,
  toFrasesPayload,
  toggleFraseEnabled,
  validateFrases,
} from './frases-pausa';

/** Helper: monta um draft com id explícito e defaults sensatos. */
function row(over: Partial<FrasePausaDraft> & { id: number }): FrasePausaDraft {
  return { command: 'pause', keyword: 'Assumir', enabled: true, ...over };
}

describe('gating — feature off (404) faz a seção sumir', () => {
  it('isFrasesFeatureOff: só 404 é feature-off', () => {
    expect(isFrasesFeatureOff(new ApiError(404, 'not found', null))).toBe(true);
    expect(isFrasesFeatureOff(new ApiError(500, 'boom', null))).toBe(false);
    expect(isFrasesFeatureOff(new ApiError(0, 'sem conexao', null))).toBe(false);
    expect(isFrasesFeatureOff(new Error('x'))).toBe(false);
    expect(isFrasesFeatureOff(null)).toBe(false);
  });
});

describe('toFrasesDraft', () => {
  it('null/undefined -> lista vazia', () => {
    expect(toFrasesDraft(null)).toEqual([]);
    expect(toFrasesDraft(undefined)).toEqual([]);
    expect(toFrasesDraft([])).toEqual([]);
  });

  it('mapeia com id local por índice e preserva os campos', () => {
    const frases: FrasePausa[] = [
      { command: 'pause', keyword: 'Aqui é a equipe', enabled: true },
      { command: 'resume', keyword: 'Voltamos', enabled: false },
    ];
    expect(toFrasesDraft(frases)).toEqual([
      { id: 1, command: 'pause', keyword: 'Aqui é a equipe', enabled: true },
      { id: 2, command: 'resume', keyword: 'Voltamos', enabled: false },
    ]);
  });

  it('coage command desconhecido pra "pause" e keyword ausente pra ""', () => {
    // biome-ignore lint/suspicious/noExplicitAny: simula payload sujo do backend
    const sujo = [{ command: 'x', enabled: 'sim' } as any];
    expect(toFrasesDraft(sujo)).toEqual([{ id: 1, command: 'pause', keyword: '', enabled: false }]);
  });
});

describe('add / remove / max 10', () => {
  it('newFraseId = max(id) + 1 (sem colidir)', () => {
    expect(newFraseId([])).toBe(1);
    expect(newFraseId([row({ id: 3 }), row({ id: 7 })])).toBe(8);
  });

  it('addFrase adiciona linha vazia (Pausar, ativa) e não muta a original', () => {
    const base: FrasePausaDraft[] = [];
    const next = addFrase(base);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ id: 1, command: 'pause', keyword: '', enabled: true });
    expect(base).toHaveLength(0);
  });

  it('atMaxFrases + addFrase respeitam o limite de 10', () => {
    const dez = Array.from({ length: MAX_FRASES }, (_, i) => row({ id: i + 1 }));
    expect(atMaxFrases(dez)).toBe(true);
    expect(addFrase(dez)).toHaveLength(MAX_FRASES); // no-op no limite
    const nove = dez.slice(0, 9);
    expect(atMaxFrases(nove)).toBe(false);
    expect(addFrase(nove)).toHaveLength(10);
  });

  it('removeFrase tira só a linha do id', () => {
    const list = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
    expect(removeFrase(list, 2).map((r) => r.id)).toEqual([1, 3]);
  });
});

describe('edição de linha', () => {
  const list = [row({ id: 1, keyword: 'a' }), row({ id: 2, keyword: 'b' })];

  it('setFraseKeyword muda só a linha alvo', () => {
    expect(setFraseKeyword(list, 2, 'novo').find((r) => r.id === 2)?.keyword).toBe('novo');
    expect(setFraseKeyword(list, 2, 'novo').find((r) => r.id === 1)?.keyword).toBe('a');
  });

  it('setFraseCommand troca o tipo', () => {
    expect(setFraseCommand(list, 1, 'resume').find((r) => r.id === 1)?.command).toBe('resume');
  });

  it('toggleFraseEnabled inverte só a linha alvo', () => {
    const t = toggleFraseEnabled(list, 1);
    expect(t.find((r) => r.id === 1)?.enabled).toBe(false);
    expect(t.find((r) => r.id === 2)?.enabled).toBe(true);
  });
});

describe('normalizeKeyword', () => {
  it('trim + lowercase + colapsa espaços internos', () => {
    expect(normalizeKeyword('  Aqui  É   a Equipe ')).toBe('aqui é a equipe');
    expect(normalizeKeyword('ASSUMIR')).toBe('assumir');
  });
});

describe('validateFrases — vazio / curto (<2) / longo (>80) / duplicata', () => {
  it('linha vazia -> "vazia"', () => {
    expect(validateFrases([row({ id: 1, keyword: '   ' })]).get(1)).toBe('vazia');
  });

  it('1 caractere -> "curta"', () => {
    expect(validateFrases([row({ id: 1, keyword: 'a' })]).get(1)).toBe('curta');
  });

  it('81 caracteres -> "longa" (2..80)', () => {
    const oitenta = 'x'.repeat(80);
    const oitentaUm = 'x'.repeat(81);
    expect(validateFrases([row({ id: 1, keyword: oitenta })]).size).toBe(0);
    expect(validateFrases([row({ id: 1, keyword: oitentaUm })]).get(1)).toBe('longa');
  });

  it('duplicata por (command, keyword normalizada): a 1ª fica, a repetida marca', () => {
    const list = [
      row({ id: 1, command: 'pause', keyword: 'Aqui é a equipe' }),
      row({ id: 2, command: 'pause', keyword: '  aqui  é a EQUIPE ' }),
    ];
    const errs = validateFrases(list);
    expect(errs.get(1)).toBeUndefined();
    expect(errs.get(2)).toBe('duplicada');
  });

  it('mesma keyword em tipos diferentes NÃO é duplicata', () => {
    const list = [
      row({ id: 1, command: 'pause', keyword: 'Equipe' }),
      row({ id: 2, command: 'resume', keyword: 'Equipe' }),
    ];
    expect(validateFrases(list).size).toBe(0);
  });

  it('linhas vazias NÃO contam como duplicata entre si', () => {
    const list = [row({ id: 1, keyword: '' }), row({ id: 2, keyword: '' })];
    const errs = validateFrases(list);
    expect(errs.get(1)).toBe('vazia');
    expect(errs.get(2)).toBe('vazia');
  });
});

describe('isFrasesValidas', () => {
  it('true só sem erros de linha e dentro do limite', () => {
    expect(isFrasesValidas([])).toBe(true);
    expect(isFrasesValidas([row({ id: 1, keyword: 'Assumir' })])).toBe(true);
    expect(isFrasesValidas([row({ id: 1, keyword: 'a' })])).toBe(false);
  });

  it('mais de 10 -> inválido mesmo com linhas ok', () => {
    const onze = Array.from({ length: 11 }, (_, i) => row({ id: i + 1, keyword: `Frase ${i}` }));
    expect(isFrasesValidas(onze)).toBe(false);
  });
});

describe('isFrasesDirty', () => {
  it('tamanho diferente -> dirty', () => {
    expect(isFrasesDirty([row({ id: 1 })], [])).toBe(true);
  });

  it('mudança de tipo/enabled -> dirty', () => {
    expect(
      isFrasesDirty([row({ id: 1, command: 'resume' })], [row({ id: 1, command: 'pause' })]),
    ).toBe(true);
    expect(isFrasesDirty([row({ id: 1, enabled: false })], [row({ id: 1, enabled: true })])).toBe(
      true,
    );
  });

  it('keyword compara já sem bordas; id local é ignorado', () => {
    expect(
      isFrasesDirty([row({ id: 9, keyword: '  Assumir  ' })], [row({ id: 1, keyword: 'Assumir' })]),
    ).toBe(false);
    expect(
      isFrasesDirty([row({ id: 1, keyword: 'Assumir!' })], [row({ id: 1, keyword: 'Assumir' })]),
    ).toBe(true);
  });
});

describe('toFrasesPayload — body do PUT (replace-set)', () => {
  it('serializa command/keyword(trim)/enabled na ordem da lista', () => {
    const list = [
      row({ id: 5, command: 'pause', keyword: '  Aqui é a equipe  ', enabled: true }),
      row({ id: 2, command: 'resume', keyword: 'Voltamos', enabled: false }),
    ];
    expect(toFrasesPayload(list)).toEqual([
      { command: 'pause', keyword: 'Aqui é a equipe', enabled: true },
      { command: 'resume', keyword: 'Voltamos', enabled: false },
    ]);
  });
});

describe('isFrasesRejeitadas — 400 do backend', () => {
  it('só 400 conta como rejeição de regra', () => {
    expect(isFrasesRejeitadas(new ApiError(400, 'invalid', null))).toBe(true);
    expect(isFrasesRejeitadas(new ApiError(500, 'boom', null))).toBe(false);
    expect(isFrasesRejeitadas(new Error('x'))).toBe(false);
  });
});
