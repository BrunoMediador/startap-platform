import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import type { FaqItem } from './api-types';
import {
  FAQ_MAX,
  type FaqDraft,
  PERGUNTA_MAX,
  RESPOSTA_MAX,
  addFaq,
  atMaxFaq,
  faqCompletos,
  isFaqDirty,
  isFaqFeatureOff,
  isFaqRejeitada,
  isFaqValido,
  newFaqId,
  removeFaq,
  setFaqPergunta,
  setFaqResposta,
  toFaqDraft,
  toFaqPayload,
  validateFaq,
} from './faq';

function row(id: number, pergunta: string, resposta: string): FaqDraft {
  return { id, pergunta, resposta };
}

describe('toFaqDraft', () => {
  it('array ausente/nulo/não-array -> []', () => {
    expect(toFaqDraft(null)).toEqual([]);
    expect(toFaqDraft(undefined)).toEqual([]);
    // valor cru inesperado do backend não deve estourar
    expect(toFaqDraft('x' as unknown as FaqItem[])).toEqual([]);
  });

  it('mapeia pares com id local por índice (1-based)', () => {
    const itens: FaqItem[] = [
      { pergunta: 'Tem estacionamento?', resposta: 'Sim, na lateral.' },
      { pergunta: 'Aceitam pix?', resposta: 'Aceitamos.' },
    ];
    expect(toFaqDraft(itens)).toEqual([
      { id: 1, pergunta: 'Tem estacionamento?', resposta: 'Sim, na lateral.' },
      { id: 2, pergunta: 'Aceitam pix?', resposta: 'Aceitamos.' },
    ]);
  });

  it('coage campos não-string pra ""', () => {
    const cru = [{ pergunta: 123, resposta: null }] as unknown as FaqItem[];
    expect(toFaqDraft(cru)).toEqual([{ id: 1, pergunta: '', resposta: '' }]);
  });
});

describe('newFaqId / addFaq / removeFaq / atMaxFaq', () => {
  it('newFaqId = max + 1 (não colide)', () => {
    expect(newFaqId([])).toBe(1);
    expect(newFaqId([row(1, '', ''), row(5, '', '')])).toBe(6);
  });

  it('addFaq acrescenta linha vazia; no-op no teto', () => {
    const um = addFaq([]);
    expect(um).toHaveLength(1);
    expect(um[0]).toMatchObject({ pergunta: '', resposta: '' });

    const cheio = Array.from({ length: FAQ_MAX }, (_, i) => row(i + 1, `p${i}`, `r${i}`));
    expect(atMaxFaq(cheio)).toBe(true);
    expect(addFaq(cheio)).toHaveLength(FAQ_MAX); // não passa de 10
  });

  it('removeFaq tira só a linha do id', () => {
    const l = [row(1, 'a', 'b'), row(2, 'c', 'd')];
    expect(removeFaq(l, 1)).toEqual([row(2, 'c', 'd')]);
  });
});

describe('setFaqPergunta / setFaqResposta', () => {
  it('edita só a linha alvo, imutável', () => {
    const l = [row(1, 'a', 'b'), row(2, 'c', 'd')];
    expect(setFaqPergunta(l, 2, 'C')).toEqual([row(1, 'a', 'b'), row(2, 'C', 'd')]);
    expect(setFaqResposta(l, 1, 'B')).toEqual([row(1, 'a', 'B'), row(2, 'c', 'd')]);
    // original intacto (imutabilidade)
    expect(l[0].resposta).toBe('b');
  });
});

describe('validateFaq', () => {
  it('linha totalmente vazia -> IGNORADA (sem erro)', () => {
    expect(validateFaq([row(1, '  ', '')]).size).toBe(0);
  });

  it('só um campo preenchido -> incompleto', () => {
    expect(validateFaq([row(1, 'Tem café?', '')]).get(1)).toBe('incompleto');
    expect(validateFaq([row(1, '', 'Tem sim')]).get(1)).toBe('incompleto');
  });

  it('pergunta acima de 120 -> pergunta_longa', () => {
    expect(validateFaq([row(1, 'x'.repeat(PERGUNTA_MAX + 1), 'ok')]).get(1)).toBe('pergunta_longa');
  });

  it('resposta acima de 300 -> resposta_longa', () => {
    expect(validateFaq([row(1, 'ok', 'y'.repeat(RESPOSTA_MAX + 1))]).get(1)).toBe('resposta_longa');
  });

  it('limite exato é válido (120 e 300)', () => {
    expect(validateFaq([row(1, 'x'.repeat(PERGUNTA_MAX), 'y'.repeat(RESPOSTA_MAX))]).size).toBe(0);
  });

  it('length usa o valor aparado (espaços nas bordas não contam)', () => {
    const pergunta = `  ${'x'.repeat(PERGUNTA_MAX)}  `; // 124 cru, 120 trim
    expect(validateFaq([row(1, pergunta, 'ok')]).size).toBe(0);
  });
});

describe('faqCompletos / isFaqValido', () => {
  it('faqCompletos = só linhas com os dois campos preenchidos', () => {
    const l = [row(1, 'a', 'b'), row(2, '', ''), row(3, 'c', ''), row(4, 'd', 'e')];
    expect(faqCompletos(l).map((d) => d.id)).toEqual([1, 4]);
  });

  it('válido quando não há erro e <=10 completos', () => {
    expect(isFaqValido([row(1, 'a', 'b'), row(2, '', '')])).toBe(true);
    expect(isFaqValido([row(1, 'a', '')])).toBe(false); // incompleto
    expect(isFaqValido([row(1, 'x'.repeat(PERGUNTA_MAX + 1), 'b')])).toBe(false); // longa
  });

  it('lista vazia é válida (limpa o FAQ)', () => {
    expect(isFaqValido([])).toBe(true);
  });
});

describe('toFaqPayload', () => {
  it('descarta vazias/incompletas e trima; par vazio não trava os demais', () => {
    const l = [
      row(1, '  Tem estacionamento?  ', '  Sim, na lateral.  '),
      row(2, '', ''), // vazia -> ignorada, NÃO bloqueia
      row(3, 'Aceitam pix?', 'Aceitamos.'),
    ];
    expect(toFaqPayload(l)).toEqual([
      { pergunta: 'Tem estacionamento?', resposta: 'Sim, na lateral.' },
      { pergunta: 'Aceitam pix?', resposta: 'Aceitamos.' },
    ]);
  });

  it('lista sem pares completos -> [] (limpa)', () => {
    expect(toFaqPayload([row(1, '', ''), row(2, 'só pergunta', '')])).toEqual([]);
  });

  it('capa defensivamente no teto de 10', () => {
    const doze = Array.from({ length: 12 }, (_, i) => row(i + 1, `p${i}`, `r${i}`));
    expect(toFaqPayload(doze)).toHaveLength(FAQ_MAX);
  });
});

describe('isFaqDirty', () => {
  it('adicionar uma linha vazia NÃO marca não-salvo', () => {
    const salvo = [row(1, 'a', 'b')];
    const comVazia = [row(1, 'a', 'b'), row(2, '', '')];
    expect(isFaqDirty(comVazia, salvo)).toBe(false);
  });

  it('ignora diferença só de espaços nas bordas', () => {
    expect(isFaqDirty([row(1, ' a ', ' b ')], [row(1, 'a', 'b')])).toBe(false);
  });

  it('detecta mudança real de conteúdo, inclusão e remoção', () => {
    expect(isFaqDirty([row(1, 'a', 'B')], [row(1, 'a', 'b')])).toBe(true);
    expect(isFaqDirty([row(1, 'a', 'b'), row(2, 'c', 'd')], [row(1, 'a', 'b')])).toBe(true);
    expect(isFaqDirty([], [row(1, 'a', 'b')])).toBe(true); // limpou
  });
});

describe('isFaqFeatureOff / isFaqRejeitada', () => {
  it('404/400 = feature off; 400 = rejeitada; 500 = nenhum', () => {
    expect(isFaqFeatureOff(new ApiError(404, 'not found', null))).toBe(true);
    expect(isFaqFeatureOff(new ApiError(400, 'bad', null))).toBe(true);
    expect(isFaqFeatureOff(new ApiError(500, 'boom', null))).toBe(false);
    expect(isFaqRejeitada(new ApiError(400, 'bad', null))).toBe(true);
    expect(isFaqRejeitada(new ApiError(404, 'not found', null))).toBe(false);
    expect(isFaqRejeitada(new Error('x'))).toBe(false);
  });
});
