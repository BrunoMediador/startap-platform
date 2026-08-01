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

describe('buildBlocoEstrutural — variante estabelecimento (MVP SCRUM-92)', () => {
  it('inclui o campo PROFISSIONAL + a instrução de escolher pelo NOME', () => {
    const bloco = buildBlocoEstrutural({ modo: 'estabelecimento', area: 'barbearia' });
    expect(bloco).toContain(BLOCO_ESTRUTURAL_MARKER);
    expect(bloco).toContain('CARTAO DE CONFIRMACAO');
    // campo do profissional no cartão (layout aprovado 31/07/2026: 👤 Profissional).
    expect(bloco).toContain('👤 Profissional:');
    // cliente escolhe pelo NOME, nunca id curto (C1/C2).
    expect(bloco).toMatch(/NOME do profissional/);
    expect(bloco).toContain('C1/C2');
  });

  it('mantém a garantia: mostra cartão + exige SIM antes de inserir_agendamento', () => {
    const bloco = buildBlocoEstrutural({ modo: 'estabelecimento', area: 'barbearia' });
    expect(bloco).toMatch(/SIM/);
    expect(bloco).toContain('inserir_agendamento');
    expect(bloco).toMatch(/SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento/);
  });

  it('horário usa 🕐 (casa o runtime buildCartaoEstabelecimentoBlock), não ⏰', () => {
    const bloco = buildBlocoEstrutural({ modo: 'estabelecimento', area: 'barbearia' });
    expect(bloco).toContain('🕐');
    // linha do cartão não usa o ⏰ do individual.
    expect(bloco).not.toMatch(/⏰ HORARIO/);
  });

  it('barbearia mantém os emojis da área (💈 marca / ✂️ serviço)', () => {
    const bloco = buildBlocoEstrutural({ modo: 'estabelecimento', area: 'barbearia' });
    expect(bloco).toContain('✂️');
  });

  it('área não-barbearia troca o serviço (manicure → 💅) e mantém 👤', () => {
    const bloco = buildBlocoEstrutural({ modo: 'estabelecimento', area: 'manicure' });
    expect(bloco).toContain('💅');
    expect(bloco).toContain('👤 Profissional:');
  });
});

describe('buildBlocoEstrutural — regressão das variantes existentes', () => {
  it('agenda (individual) NÃO ganha campo de profissional', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    expect(bloco).not.toContain('PROFISSIONAL');
    expect(bloco).toContain('⏰'); // individual segue com ⏰ no horário.
  });

  it('atendente segue sem cartão nem profissional', () => {
    const bloco = buildBlocoEstrutural({ modo: 'atendente' });
    expect(bloco).not.toContain('PROFISSIONAL');
    expect(bloco).not.toContain('CARTAO DE CONFIRMACAO');
  });
});
