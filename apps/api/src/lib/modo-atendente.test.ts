import { describe, expect, it } from 'vitest';
import { buildModoAtendenteBlock } from './modo-atendente.js';

describe('buildModoAtendenteBlock', () => {
  it('regras duras comuns: não agenda, escala, registra interesse, não invasivo, expediente', () => {
    const b = buildModoAtendenteBlock({ hasLink: false });
    expect(b).toContain('MODO ATENDENTE');
    expect(b).toContain('NAO tem acesso a agenda');
    expect(b).toMatch(/NUNCA diga "agendei"/);
    expect(b).toContain('escalar_para_humano');
    expect(b).toContain('registrar_interesse');
    expect(b).toContain('FORA DO EXPEDIENTE');
    expect(b).toContain('NAO SEJA INVASIVO');
    // Nunca inventa dado fora do contexto.
    expect(b).toMatch(/NAO invente/);
  });

  it('hasLink=true: instrui ENTREGAR o link, não fala "equipe confirma"', () => {
    const b = buildModoAtendenteBlock({ hasLink: true });
    expect(b).toContain('entregue o LINK');
    expect(b).not.toContain('EQUIPE vai confirmar');
    // não instrui inventar link (o link vem do contexto).
    expect(b).toContain('que esta no CONTEXTO');
  });

  it('hasLink=false: instrui que a EQUIPE confirma e a NÃO mencionar/inventar link', () => {
    const b = buildModoAtendenteBlock({ hasLink: false });
    expect(b).toContain('EQUIPE vai confirmar');
    expect(b).toMatch(/NAO mencione nem invente link/);
    expect(b).not.toContain('entregue o LINK');
  });
});
