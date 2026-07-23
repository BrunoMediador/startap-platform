import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  DEFAULT_NIVEIS,
  DEFAULT_NIVEL,
  type TomNivelOpcao,
  fetchTomAssistente,
  indexToNivel,
  isTomInvalido,
  isTomNivel,
  isTomUnavailable,
  labelDoNivel,
  nivelToIndex,
  ordenarNiveis,
  parseNiveis,
  parseNivel,
  putTomAssistente,
} from './tom-assistente';

// Mocka o cliente HTTP: o que importa testar é o MAPA status/erro -> outcome, não a rede
// (mesmo padrão de prompt-builder/demo-chat). Cada caso controla o que apiFetch resolve/rejeita.
const apiFetchMock = vi.fn();
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return { ...real, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

afterEach(() => apiFetchMock.mockReset());

// Catálogo fora de ordem de propósito — nivelToIndex/indexToNivel devem ordenar por `ordem`.
const NIVEIS_DESORDENADOS: TomNivelOpcao[] = [
  { id: 'caloroso', label: 'Caloroso', ordem: 2 },
  { id: 'direto', label: 'Direto e objetivo', ordem: 0 },
  { id: 'bem_descontraido', label: 'Bem descontraído', ordem: 3 },
  { id: 'equilibrado', label: 'Equilibrado', ordem: 1 },
];

describe('mapeamento nível <-> posição do slider (função pura)', () => {
  it('nivelToIndex respeita a `ordem` do catálogo, não a ordem do array', () => {
    expect(nivelToIndex('direto', NIVEIS_DESORDENADOS)).toBe(0);
    expect(nivelToIndex('equilibrado', NIVEIS_DESORDENADOS)).toBe(1);
    expect(nivelToIndex('caloroso', NIVEIS_DESORDENADOS)).toBe(2);
    expect(nivelToIndex('bem_descontraido', NIVEIS_DESORDENADOS)).toBe(3);
  });

  it('indexToNivel é o inverso de nivelToIndex nas posições válidas', () => {
    for (const opt of NIVEIS_DESORDENADOS) {
      const idx = nivelToIndex(opt.id, NIVEIS_DESORDENADOS);
      expect(indexToNivel(idx, NIVEIS_DESORDENADOS)).toBe(opt.id);
    }
  });

  it('indexToNivel arredonda e clampa aos limites do catálogo', () => {
    // 0.4 -> 0 (direto); 2.6 -> 3 (bem_descontraido); acima do teto -> última parada.
    expect(indexToNivel(0.4, NIVEIS_DESORDENADOS)).toBe('direto');
    expect(indexToNivel(2.6, NIVEIS_DESORDENADOS)).toBe('bem_descontraido');
    expect(indexToNivel(99, NIVEIS_DESORDENADOS)).toBe('bem_descontraido');
    expect(indexToNivel(-5, NIVEIS_DESORDENADOS)).toBe('direto');
  });

  it('nivel ausente do catálogo cai no DEFAULT_NIVEL (parada do meio, tom neutro)', () => {
    const semEquilibrado: TomNivelOpcao[] = [
      { id: 'direto', label: 'Direto', ordem: 0 },
      { id: 'caloroso', label: 'Caloroso', ordem: 1 },
    ];
    // 'equilibrado' (DEFAULT) não está no catálogo -> índice do meio, nunca -1.
    const i = nivelToIndex(DEFAULT_NIVEL, semEquilibrado);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(semEquilibrado.length);
  });

  it('catálogo vazio nunca estoura (index 0 / DEFAULT_NIVEL)', () => {
    expect(nivelToIndex('caloroso', [])).toBe(0);
    expect(indexToNivel(2, [])).toBe(DEFAULT_NIVEL);
  });

  it('ordenarNiveis é estável e não muta o array de entrada', () => {
    const antes = [...NIVEIS_DESORDENADOS];
    const ord = ordenarNiveis(NIVEIS_DESORDENADOS);
    expect(ord.map((n) => n.id)).toEqual(['direto', 'equilibrado', 'caloroso', 'bem_descontraido']);
    expect(NIVEIS_DESORDENADOS).toEqual(antes); // entrada intacta
  });

  it('labelDoNivel usa o label do backend; fallback pro id fora do catálogo', () => {
    expect(labelDoNivel('direto', NIVEIS_DESORDENADOS)).toBe('Direto e objetivo');
    expect(labelDoNivel('caloroso', [])).toBe('caloroso');
  });
});

describe('parsers defensivos', () => {
  it('isTomNivel só aceita os IDs conhecidos', () => {
    expect(isTomNivel('equilibrado')).toBe(true);
    expect(isTomNivel('bem_descontraido')).toBe(true);
    expect(isTomNivel('agressivo')).toBe(false);
    expect(isTomNivel(1)).toBe(false);
    expect(isTomNivel(null)).toBe(false);
  });

  it('parseNivel devolve DEFAULT_NIVEL pra valor ausente/desconhecido', () => {
    expect(parseNivel('caloroso')).toBe('caloroso');
    expect(parseNivel('xxx')).toBe(DEFAULT_NIVEL);
    expect(parseNivel(undefined)).toBe(DEFAULT_NIVEL);
  });

  it('parseNiveis descarta entradas malformadas e cai no default se sobrar vazio', () => {
    const raw = [
      { id: 'direto', label: 'Direto', ordem: 0 },
      { id: 'desconhecido', label: 'X', ordem: 1 }, // id inválido
      { id: 'caloroso', label: '', ordem: 2 }, // label vazio
      { id: 'equilibrado', label: 'Eq', ordem: 'nan' }, // ordem não-numérica
    ];
    expect(parseNiveis(raw)).toEqual([{ id: 'direto', label: 'Direto', ordem: 0 }]);
    expect(parseNiveis('nope')).toEqual(DEFAULT_NIVEIS);
    expect(parseNiveis([])).toEqual(DEFAULT_NIVEIS);
  });
});

describe('fetchTomAssistente — degradação graciosa', () => {
  it('404 -> { status: "indisponivel" } (a seção some, não é erro)', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(404, 'not found', null));
    await expect(fetchTomAssistente()).resolves.toEqual({ status: 'indisponivel' });
  });

  it('isTomUnavailable só reconhece o 404', () => {
    expect(isTomUnavailable(new ApiError(404, 'x', null))).toBe(true);
    expect(isTomUnavailable(new ApiError(500, 'x', null))).toBe(false);
    expect(isTomUnavailable(new Error('boom'))).toBe(false);
  });

  it('erro real (500) PROPAGA -> vira ErrorState com retry (não some silenciosamente)', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(500, 'boom', null));
    await expect(fetchTomAssistente()).rejects.toBeInstanceOf(ApiError);
  });

  it('erro de rede (status 0) também propaga', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(0, 'sem conexao', null));
    await expect(fetchTomAssistente()).rejects.toBeInstanceOf(ApiError);
  });

  it('200 normaliza nivel + catálogo (shape cru defensivo)', async () => {
    apiFetchMock.mockResolvedValue({
      nivel: 'caloroso',
      niveis: [
        { id: 'direto', label: 'Direto', ordem: 0 },
        { id: 'lixo' }, // descartado
      ],
    });
    await expect(fetchTomAssistente()).resolves.toEqual({
      status: 'ok',
      nivel: 'caloroso',
      niveis: [{ id: 'direto', label: 'Direto', ordem: 0 }],
    });
  });

  it('200 sem `niveis` cai no catálogo default; nivel desconhecido -> DEFAULT_NIVEL', async () => {
    apiFetchMock.mockResolvedValue({ nivel: 'xxx' });
    await expect(fetchTomAssistente()).resolves.toEqual({
      status: 'ok',
      nivel: DEFAULT_NIVEL,
      niveis: DEFAULT_NIVEIS,
    });
  });
});

describe('putTomAssistente — envia { nivel } e ramifica o erro', () => {
  it('envia body { nivel } no PUT e devolve o novo estado', async () => {
    apiFetchMock.mockResolvedValue({ nivel: 'direto' });
    const out = await putTomAssistente('direto');
    expect(out).toEqual({ nivel: 'direto', niveis: null });
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/portal/tom-assistente',
      expect.objectContaining({ method: 'PUT', body: { nivel: 'direto' } }),
    );
  });

  it('reenviou catálogo no PUT -> vem parseado; senão null (o hook preserva o cache)', async () => {
    apiFetchMock.mockResolvedValue({
      nivel: 'equilibrado',
      niveis: [{ id: 'equilibrado', label: 'Equilibrado', ordem: 1 }],
    });
    const out = await putTomAssistente('equilibrado');
    expect(out.niveis).toEqual([{ id: 'equilibrado', label: 'Equilibrado', ordem: 1 }]);
  });

  it('isTomInvalido reconhece o 400 (nível rejeitado) e nada mais', () => {
    expect(isTomInvalido(new ApiError(400, 'invalid', null))).toBe(true);
    expect(isTomInvalido(new ApiError(500, 'x', null))).toBe(false);
  });

  it('falha do PUT propaga ApiError (o componente ramifica no onError)', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(400, 'nivel invalido', null));
    await expect(putTomAssistente('direto')).rejects.toBeInstanceOf(ApiError);
  });
});
