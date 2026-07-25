import { describe, expect, it } from 'vitest';
import {
  buildCartaoEmojiOverrideBlock,
  buildCartaoEstabelecimentoBlock,
  emojisForArea,
  isBarbearia,
} from './area-emojis.js';

// Bloco de estabelecimento ESPERADO para barbearia (após o fix do Bug 1 — confirmação
// SEMPRE, inclusive back-to-back). Os testes de barbearia provam que
// buildCartaoEstabelecimentoBlock('barbearia') é byte-a-byte este texto — regressão
// dos estabelecimentos atuais (emojis 👤/📅/🕐/✂️/💰 inalterados; só a REGRA endurecida).
const ESTAB_BARBEARIA = [
  '[CARTAO DE CONFIRMACAO - ESTABELECIMENTO — REGRA CRITICA, VIOLACAO = ERRO GRAVE]',
  'Antes de CADA agendamento você DEVE, OBRIGATORIAMENTE e SEM EXCEÇÃO:',
  '1. Mostrar o CARTAO DE CONFIRMACAO completo (todos os campos abaixo).',
  '2. Esperar o cliente responder SIM (ou equivalente claro: "isso", "pode marcar").',
  '3. SÓ DEPOIS do SIM, chamar inserir_agendamento.',
  'Isso vale para TODO agendamento, INCLUSIVE o 2º, 3º… na MESMA conversa (back-to-back):',
  'cada novo horário recomeça o fluxo — mostra o cartão e pede SIM de novo. NUNCA agende',
  'direto, NUNCA pule o cartão, NUNCA assuma o SIM porque o cliente já confirmou antes.',
  'Neste estabelecimento o cliente escolhe o profissional, então o cartão DEVE incluir o',
  'nome do profissional escolhido (o nome que está em [PROFISSIONAIS], não o id curto C1/C2).',
  'Formato do cartão:',
  '👤 PROFISSIONAL: <nome do profissional escolhido>',
  '📅 DIA: <dia> / 🕐 HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
  'Termine o cartão pedindo: "Responda SIM para confirmar." Mantenha o tom da persona.',
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

  // SCRUM-84: persona custom (dono estilizou o cartão à mão — ex. Ingrid com 🌻) é
  // AUTORIDADE FINAL. Mesmo em área não-barbearia, o override NÃO entra — senão
  // sobrescreve os emojis escolhidos de propósito.
  it('prompt_custom=true + área "outro" → string vazia (persona manda, sem override)', () => {
    expect(buildCartaoEmojiOverrideBlock('outro', true)).toBe('');
  });

  it('prompt_custom=true + salão/manicure → string vazia (não sobrepõe persona estilizada)', () => {
    expect(buildCartaoEmojiOverrideBlock('salao', true)).toBe('');
    expect(buildCartaoEmojiOverrideBlock('manicure', true)).toBe('');
  });

  it('prompt_custom=false (default) → comportamento byte-a-byte de antes', () => {
    // Passar false explicitamente ou omitir dá o MESMO resultado das asserções acima.
    expect(buildCartaoEmojiOverrideBlock('outro', false)).toBe(
      buildCartaoEmojiOverrideBlock('outro'),
    );
    expect(buildCartaoEmojiOverrideBlock('outro', false)).not.toBe('');
    expect(buildCartaoEmojiOverrideBlock('barbearia', false)).toBe('');
  });
});

describe('buildCartaoEstabelecimentoBlock — caminho ESTABELECIMENTO', () => {
  // REGRESSÃO: barbearia tem que ser BYTE-A-BYTE o bloco esperado (pós fix Bug 1).
  it('barbearia → idêntico byte-a-byte ao bloco esperado (emojis intactos)', () => {
    expect(buildCartaoEstabelecimentoBlock('barbearia')).toBe(ESTAB_BARBEARIA);
  });

  // Bug 1: o bloco DEVE exigir confirmação SEMPRE, inclusive em agendamentos de
  // SEGUIDA (back-to-back) — foi onde o bot pulava o cartão no teste do barber_dragon.
  it('exige cartão+SIM a CADA agendamento, inclusive back-to-back (fix Bug 1)', () => {
    for (const area of ['barbearia', 'manicure', null]) {
      const block = buildCartaoEstabelecimentoBlock(area);
      expect(block).toMatch(/CADA agendamento/i);
      expect(block).toMatch(/back-to-back|mesma conversa/i);
      expect(block).toMatch(/NUNCA pule o cartão|NUNCA agende\s+direto/i);
      expect(block).toMatch(/Responda SIM/i);
    }
  });

  it('salão → mantém 👤/🕐/✂️ no estab (cartão não mostra a marca, então == barbearia)', () => {
    // No cartão de ESTABELECIMENTO a "marca" (💈/💇) não aparece — só profissional,
    // dia, horário, serviço, valor. Salão usa ✂️ no serviço (igual barbearia), logo
    // o bloco é legitimamente idêntico ao de barbearia. Isso é esperado e correto.
    const block = buildCartaoEstabelecimentoBlock('salao');
    expect(block).toContain('👤 PROFISSIONAL:');
    expect(block).toContain('🕐 HORARIO');
    expect(block).toContain('✂️ SERVICO');
    expect(block).toBe(ESTAB_BARBEARIA);
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

// SCRUM-85: cartão de estabelecimento respeita persona custom — MAS, diferente do
// individual, o bloco NÃO some (ele carrega a regra ESTRUTURAL crítica). Separamos:
// (1) regra estrutural = SEMPRE injetada; (2) estilo/emojis = só com prompt_custom=false.
describe('buildCartaoEstabelecimentoBlock — prompt_custom (SCRUM-85)', () => {
  it('prompt_custom=false (default) → BYTE-A-BYTE o bloco de hoje (protege barber_dragon)', () => {
    // O ramo false NÃO pode mudar 1 byte: passar false explícito == omitir == atual.
    expect(buildCartaoEstabelecimentoBlock('barbearia', false)).toBe(ESTAB_BARBEARIA);
    expect(buildCartaoEstabelecimentoBlock('barbearia', false)).toBe(
      buildCartaoEstabelecimentoBlock('barbearia'),
    );
    for (const area of ['barbearia', 'salao', 'manicure', 'estetica', 'outro', null, undefined]) {
      expect(buildCartaoEstabelecimentoBlock(area, false)).toBe(
        buildCartaoEstabelecimentoBlock(area),
      );
    }
  });

  it('prompt_custom=true → mantém a REGRA ESTRUTURAL inegociável (cartão+SIM+PROFISSIONAL+back-to-back)', () => {
    for (const area of ['barbearia', 'manicure', 'outro', null]) {
      const block = buildCartaoEstabelecimentoBlock(area, true);
      // cartão obrigatório + SIM antes de inserir_agendamento
      expect(block).toMatch(/CADA agendamento/i);
      expect(block).toMatch(/SÓ DEPOIS do SIM, chamar inserir_agendamento/);
      expect(block).toMatch(/Responda SIM/i);
      // back-to-back
      expect(block).toMatch(/back-to-back|mesma conversa/i);
      expect(block).toMatch(/NUNCA pule o cartão|NUNCA agende\s+direto/i);
      // PROFISSIONAL pelo nome (campo obrigatório preservado)
      expect(block).toContain('PROFISSIONAL: <nome do profissional escolhido>');
      expect(block).toContain('nome que está em [PROFISSIONAIS]');
      // demais campos obrigatórios seguem presentes
      expect(block).toMatch(/DIA: <dia>/);
      expect(block).toMatch(/HORARIO: <horario>/);
      expect(block).toMatch(/SERVICO: <servico>/);
      expect(block).toMatch(/VALOR: <valor>/);
    }
  });

  it('prompt_custom=true → NÃO impõe emojis da área (persona custom dita o estilo)', () => {
    // Nenhum ícone de área nas linhas de formato — a persona escolhe (caso Ingrid 🌻).
    for (const area of ['barbearia', 'manicure', 'estetica', 'salao', 'outro', null]) {
      const block = buildCartaoEstabelecimentoBlock(area, true);
      expect(block).not.toContain('👤 PROFISSIONAL');
      expect(block).not.toContain('🕐 HORARIO');
      expect(block).not.toContain('✂️ SERVICO');
      expect(block).not.toContain('💅 SERVICO');
      expect(block).not.toContain('📅 DIA');
      expect(block).not.toContain('💰 VALOR');
      // a instrução avisa que os emojis são da persona
      expect(block).toContain('use os emojis e o estilo da SUA persona');
    }
  });

  it('prompt_custom=true difere do false SÓ nas linhas de estilo (estrutura idêntica)', () => {
    const custom = buildCartaoEstabelecimentoBlock('manicure', true);
    const legado = buildCartaoEstabelecimentoBlock('manicure', false);
    expect(custom).not.toBe(legado);
    // as 10 primeiras linhas (regra estrutural) são idênticas entre os dois ramos
    const head = (s: string) => s.split('\n').slice(0, 10).join('\n');
    expect(head(custom)).toBe(head(legado));
  });
});
