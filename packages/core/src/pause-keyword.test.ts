import { describe, expect, it } from 'vitest';
import { normalizePauseKeyword } from './pause-keyword.js';

describe('normalizePauseKeyword — fonte única do keyword_norm (portal + matcher do bot)', () => {
  it('minúsculas + remove espaços', () => {
    expect(normalizePauseKeyword('Atendente Aqui!!')).toBe('atendenteaqui!!');
    expect(normalizePauseKeyword('  assistente   voltar!!  ')).toBe('assistentevoltar!!');
  });

  it('remove acentos (NFD sem marcas)', () => {
    expect(normalizePauseKeyword('José saiu')).toBe('josesaiu');
    expect(normalizePauseKeyword('Atenção agora')).toBe('atencaoagora');
  });

  it('é idempotente sobre o próprio resultado', () => {
    const once = normalizePauseKeyword('Recepção Assumiu!!');
    expect(normalizePauseKeyword(once)).toBe(once);
  });
});
