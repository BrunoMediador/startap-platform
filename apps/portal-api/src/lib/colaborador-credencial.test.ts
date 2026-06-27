import { describe, expect, it } from 'vitest';
import {
  PASSWORD_ALPHABET,
  PASSWORD_LENGTH,
  genColaboradorPassword,
} from './colaborador-credencial.js';

describe('genColaboradorPassword', () => {
  it('gera 14 chars, só do alfabeto sem ambíguos', () => {
    const allowed = new Set(PASSWORD_ALPHABET.split(''));
    for (let i = 0; i < 200; i++) {
      const pw = genColaboradorPassword();
      expect(pw).toHaveLength(PASSWORD_LENGTH);
      for (const ch of pw) expect(allowed.has(ch)).toBe(true);
      // Sem caracteres ambíguos (defesa contra erro de transcrição na hora de repassar).
      expect(pw).not.toMatch(/[0O1lI]/);
    }
  });

  it('é praticamente único entre chamadas (entropia suficiente)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(genColaboradorPassword());
    // 500 amostras de um espaço gigante — colisão praticamente impossível.
    expect(seen.size).toBe(500);
  });
});
