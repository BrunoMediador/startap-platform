import { describe, expect, it } from 'vitest';
import { buildEquipeBlock, buildModoAtendenteBlock } from './modo-atendente.js';

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

  it('transparencia LGPD (art. 9): avisa 1x que repassa os dados pra equipe, informativo (nao gate)', () => {
    const b = buildModoAtendenteBlock({ hasLink: false });
    expect(b).toContain('TRANSPARENCIA');
    expect(b).toMatch(/passar pra equipe/i);
    // informativo, nao permissao: nao trava esperando "sim"; nao repete.
    expect(b).toMatch(/NAO e permissao/i);
    expect(b).toMatch(/NAO repita/i);
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

  // ── EQUIPE (SCRUM-59) ──────────────────────────────────────────────────────
  it('hasEquipe=true: instrui responder "quem faz X" pelo [EQUIPE] e NÃO inventar disponibilidade', () => {
    const b = buildModoAtendenteBlock({ hasLink: false, hasEquipe: true });
    expect(b).toContain('[EQUIPE - VARIOS PROFISSIONAIS]');
    expect(b).toMatch(/quem faz X/i);
    expect(b).toMatch(/NAO ha agenda por profissional/i);
    expect(b).toMatch(/invente disponibilidade/i);
  });

  it('hasEquipe ausente/false: nenhuma instrução de equipe (individual byte-a-byte)', () => {
    expect(buildModoAtendenteBlock({ hasLink: false })).not.toContain('VARIOS PROFISSIONAIS');
    expect(buildModoAtendenteBlock({ hasLink: false, hasEquipe: false })).not.toContain(
      'VARIOS PROFISSIONAIS',
    );
  });
});

describe('buildEquipeBlock', () => {
  it('lista nome + serviços de cada profissional', () => {
    const b = buildEquipeBlock([
      { nome: 'Thomas', servicos: ['corte', 'barba'] },
      { nome: 'Isaac', servicos: ['corte'] },
    ]);
    expect(b).toContain('[EQUIPE - PROFISSIONAIS DESTE NEGOCIO]');
    expect(b).toContain('- Thomas: corte, barba');
    expect(b).toContain('- Isaac: corte');
  });

  it('colaborador SEM serviços vinculados = só o nome', () => {
    const b = buildEquipeBlock([{ nome: 'Bene', servicos: [] }]);
    expect(b).toContain('- Bene');
    expect(b).not.toContain('- Bene:'); // sem ": <servicos>"
  });

  it('sem membros (ou só nomes vazios) -> bloco ausente ("")', () => {
    expect(buildEquipeBlock([])).toBe('');
    expect(buildEquipeBlock([{ nome: '   ', servicos: ['x'] }])).toBe('');
  });

  it('NUNCA menciona gcal/calendarId/agenda (só nome + serviços)', () => {
    const b = buildEquipeBlock([{ nome: 'Thomas', servicos: ['corte'] }]);
    expect(b).not.toMatch(/gcal|calendar|agenda|horario/i);
  });
});
