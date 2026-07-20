/**
 * Testes do BLOCO_ESTRUTURAL (SCRUM-92) — a garantia da mecânica de agendamento.
 *
 * Foco: a variante AGENDA sempre carrega cartão + exigência de SIM antes de
 * inserir_agendamento; a ATENDENTE nunca marca horário; o marcador estável está
 * presente em ambas (o approve prova por ele que a garantia foi colada).
 */
import { describe, expect, it } from 'vitest';
import { BLOCO_ESTRUTURAL_MARKER, buildBlocoEstrutural } from './bloco-estrutural.js';

describe('buildBlocoEstrutural — variante agenda', () => {
  it('exige cartão de confirmação + SIM antes de inserir_agendamento', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    expect(bloco).toContain(BLOCO_ESTRUTURAL_MARKER);
    expect(bloco).toContain('CARTAO DE CONFIRMACAO');
    expect(bloco).toMatch(/SIM/);
    expect(bloco).toContain('inserir_agendamento');
    // Ordem: o SIM tem que vir ANTES da ferramenta (a trava do fluxo).
    expect(bloco).toMatch(/SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento/);
  });

  it('barbearia usa os emojis atuais (💈/✂️), sem regressão visual', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    expect(bloco).toContain('💈');
    expect(bloco).toContain('✂️');
  });

  it('área não-barbearia troca a marca do cartão (salão → 💇)', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'salao' });
    expect(bloco).toContain('💇');
  });

  it('área nula/desconhecida cai no genérico (sem 💈)', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: null });
    expect(bloco).not.toContain('💈');
    expect(bloco).toContain('CARTAO DE CONFIRMACAO');
  });
});

describe('buildBlocoEstrutural — variante atendente', () => {
  it('NÃO marca horário e escala pra humano', () => {
    const bloco = buildBlocoEstrutural({ modo: 'atendente' });
    expect(bloco).toContain(BLOCO_ESTRUTURAL_MARKER);
    expect(bloco).not.toContain('CARTAO DE CONFIRMACAO');
    expect(bloco).toMatch(/NÃO marca horário/);
    expect(bloco).toMatch(/atendente humano/);
  });
});
