import { describe, expect, it } from 'vitest';
import {
  buildCartaoEmojiOverrideBlock,
  buildCartaoEstabelecimentoBlock,
  emojisForArea,
  isBarbearia,
} from './area-emojis.js';

// O bloco de estabelecimento que o #325 produzia ANTES desta feature (hardcoded).
// Os testes de barbearia provam que buildCartaoEstabelecimentoBlock('barbearia')
// é byte-a-byte este texto — regressão dos pagantes/estabelecimentos atuais.
const ESTAB_325_BARBEARIA = [
  '[CARTAO DE CONFIRMACAO - ESTABELECIMENTO]',
  'Antes de gravar, mostre o cartão de confirmação e peça SIM. Neste estabelecimento o',
  'cliente escolhe o profissional, então o cartão DEVE incluir o nome do profissional',
  'escolhido (o nome que está em [PROFISSIONAIS], não o id curto C1/C2). Use o formato:',
  '👤 PROFISSIONAL: <nome do profissional escolhido>',
  '📅 DIA: <dia> / 🕐 HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
  'Mantenha o tom da persona. Só chame inserir_agendamento depois do SIM.',
].join('\n');

describe('area-emojis — mapa área→emojis', () => {
  it('barbearia usa os emojis de HOJE (💈 marca, ✂️ serviço)', () => {
    const e = emojisForArea('barbearia');
    expect(e.marca).toBe('💈');
    expect(e.servico).toBe('✂️');
    expect(e.dia).toBe('📅');
    expect(e.valor).toBe('💰');
    expect(e.confirma).toBe('✅');
    expect(e.profissional).toBe('👤');
  });

  it('salão/cabeleireiro usa 💇 e mantém ✂️ no serviço', () => {
    for (const area of ['salao', 'salão', 'cabeleireiro']) {
      const e = emojisForArea(area);
      expect(e.marca).toBe('💇');
      expect(e.servico).toBe('✂️');
    }
  });

  it('manicure usa 💅 (sem tesoura nem poste de barbearia)', () => {
    const e = emojisForArea('manicure');
    expect(e.marca).toBe('💅');
    expect(e.servico).toBe('💅');
    expect(e.marca).not.toBe('💈');
  });

  it('estética usa 💆 / ✨', () => {
    const e = emojisForArea('estetica');
    expect(e.marca).toBe('💆');
    expect(e.servico).toBe('✨');
  });

  it('área "outro" / NULL / desconhecida → genérico SEM 💈 nem ✂️', () => {
    for (const area of ['outro', null, undefined, 'tatuagem', '']) {
      const e = emojisForArea(area);
      expect(e.marca).not.toBe('💈');
      expect(e.servico).not.toBe('✂️');
      expect(e.dia).toBe('📅'); // agenda neutra
      expect(e.confirma).toBe('✅');
    }
  });

  it('isBarbearia só é true pra exatamente "barbearia"', () => {
    expect(isBarbearia('barbearia')).toBe(true);
    expect(isBarbearia('salao')).toBe(false);
    expect(isBarbearia(null)).toBe(false);
    expect(isBarbearia(undefined)).toBe(false);
  });
});

describe('buildCartaoEmojiOverrideBlock — caminho INDIVIDUAL', () => {
  // REGRESSÃO PAGANTES: barbearia (Cirilo/Samuel) NÃO recebe bloco nenhum →
  // systemPrompt byte-a-byte o de hoje, cartão segue 💈/✂️ do bot_prompt.
  it('barbearia → string vazia (nada injetado, cartão atual intocado)', () => {
    expect(buildCartaoEmojiOverrideBlock('barbearia')).toBe('');
  });

  it('área NULL/desconhecida → string vazia (não arrisca clone antigo)', () => {
    expect(buildCartaoEmojiOverrideBlock(null)).toBe('');
    expect(buildCartaoEmojiOverrideBlock(undefined)).toBe('');
  });

  it('salão → injeta bloco de override com 💇 e proíbe 💈', () => {
    const block = buildCartaoEmojiOverrideBlock('salao');
    expect(block).not.toBe('');
    expect(block).toContain('[CARTAO DE CONFIRMACAO - EMOJIS DESTE NEGOCIO]');
    expect(block).toContain('💇');
    expect(block).toContain('NAO use 💈');
  });

  it('manicure → bloco com 💅, sem 💈', () => {
    const block = buildCartaoEmojiOverrideBlock('manicure');
    expect(block).toContain('💅');
    expect(block).not.toContain('💈 no cabecalho');
  });

  it('estética → bloco com 💆 e ✨', () => {
    const block = buildCartaoEmojiOverrideBlock('estetica');
    expect(block).toContain('💆');
    expect(block).toContain('✨');
  });

  it('área "outro" → bloco genérico (tira a barbearia do cartão antigo)', () => {
    const block = buildCartaoEmojiOverrideBlock('outro');
    expect(block).not.toBe('');
    expect(block).toContain('NAO use 💈');
  });
});

describe('buildCartaoEstabelecimentoBlock — caminho ESTABELECIMENTO', () => {
  // REGRESSÃO: barbearia tem que ser BYTE-A-BYTE o bloco hardcoded do #325.
  it('barbearia → idêntico byte-a-byte ao bloco do #325', () => {
    expect(buildCartaoEstabelecimentoBlock('barbearia')).toBe(ESTAB_325_BARBEARIA);
  });

  it('salão → mantém 👤/🕐/✂️ no estab (cartão não mostra a marca, então == barbearia)', () => {
    // No cartão de ESTABELECIMENTO a "marca" (💈/💇) não aparece — só profissional,
    // dia, horário, serviço, valor. Salão usa ✂️ no serviço (igual barbearia), logo
    // o bloco é legitimamente idêntico ao de barbearia. Isso é esperado e correto.
    const block = buildCartaoEstabelecimentoBlock('salao');
    expect(block).toContain('👤 PROFISSIONAL:');
    expect(block).toContain('🕐 HORARIO');
    expect(block).toContain('✂️ SERVICO');
    expect(block).toBe(ESTAB_325_BARBEARIA);
  });

  it('manicure → 💅 no serviço, sem ✂️ de barbearia', () => {
    const block = buildCartaoEstabelecimentoBlock('manicure');
    expect(block).toContain('💅 SERVICO');
    expect(block).not.toContain('✂️ SERVICO');
    expect(block).toContain('👤 PROFISSIONAL:'); // regra do profissional preservada
  });

  it('área NULL/desconhecida → genérico, sem ✂️/💈, ainda com profissional', () => {
    const block = buildCartaoEstabelecimentoBlock(null);
    expect(block).not.toContain('✂️ SERVICO');
    expect(block).not.toContain('💈');
    expect(block).toContain('👤 PROFISSIONAL:');
    expect(block).toContain('🕐 HORARIO');
  });
});
