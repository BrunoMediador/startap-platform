import { describe, expect, it } from 'vitest';
import { ERRO_BOUNDARY, ERRO_GLOBAL, ERRO_NAO_ENCONTRADO, HOME_HREF } from './telas-erro';

// Sem RTL/jsdom no harness do portal (so pure-fn). Cobrimos o CONTRATO da copy
// das telas de erro: rota de fuga correta, PT-BR sem jargao/ingles, sem
// "desculpe" repetido, e presenca das acoes que cada boundary promete.

const todaCopy = [
  ...Object.values(ERRO_BOUNDARY),
  ...Object.values(ERRO_NAO_ENCONTRADO),
  ...Object.values(ERRO_GLOBAL),
];

describe('telas de erro — copy', () => {
  it('a rota de fuga aponta pro inicio autenticado', () => {
    expect(HOME_HREF).toBe('/inicio');
    expect(ERRO_BOUNDARY.home).toBe('Voltar ao início');
    expect(ERRO_NAO_ENCONTRADO.home).toBe('Voltar ao início');
  });

  it('cada string e nao-vazia e sem espaco sobrando', () => {
    for (const s of todaCopy) {
      expect(s.length).toBeGreaterThan(0);
      expect(s).toBe(s.trim());
    }
  });

  it('sem jargao tecnico / vazamento de ingles', () => {
    const proibidos = /\b(error|undefined|null|exception|stack|trace|500|404|render)\b/i;
    for (const s of todaCopy) {
      expect(s).not.toMatch(proibidos);
    }
  });

  it('nao pede "desculpa" (tom de dono de PME, sem lamento repetido)', () => {
    for (const s of todaCopy) {
      expect(s.toLowerCase()).not.toContain('desculp');
    }
  });

  it('boundary de rota oferece retry + voltar; global oferece recarregar', () => {
    expect(ERRO_BOUNDARY.retry).toBe('Tentar de novo');
    expect(ERRO_GLOBAL.reload).toContain('Recarregar');
    // 404 nao tem retry (nao ha o que re-tentar numa URL inexistente).
    expect(ERRO_NAO_ENCONTRADO).not.toHaveProperty('retry');
  });
});
