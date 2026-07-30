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

  // ADR 0035 §2.1 (emenda 30/07): bot_prompt é cópia materializada — o parâmetro
  // `promptCustom` (SCRUM-84 original, "persona custom é autoridade final, não sobrepõe
  // emoji") foi REMOVIDO da assinatura. A função só recebe `area` agora: em área
  // não-barbearia o override SEMPRE é injetado, mesmo que a persona do clone `baked` seja
  // custom (caso hipotético: Ingrid tem persona custom mas é `cartao_mode='runtime'`, então
  // NUNCA chega aqui na prática — medição de prod 30/07 confirma zero clone hoje na
  // combinação área≠barbearia + baked + persona custom). Este teste EXISTE para o dia em
  // que um clone novo nascer nessa combinação: prova qual é o comportamento (não há mais
  // supressão condicional — decisão aceita, ver PR).
  it('área "outro" (baked, ex-persona-custom hipotética) → override é injetado do mesmo jeito', () => {
    const block = buildCartaoEmojiOverrideBlock('outro');
    expect(block).not.toBe('');
    expect(block).toContain('[CARTAO DE CONFIRMACAO - EMOJIS DESTE NEGOCIO]');
  });

  it('assinatura aceita só 1 argumento (promptCustom removido, SCRUM-84 sticky morreu)', () => {
    // @ts-expect-error — 2º argumento não existe mais na assinatura.
    expect(buildCartaoEmojiOverrideBlock('outro', true)).not.toBe('');
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

// ADR 0035 §2.1 (emenda 30/07): bot_prompt é cópia materializada — o parâmetro
// `promptCustom` (SCRUM-85 original) foi REMOVIDO. A regra ESTRUTURAL (cartão+SIM+
// PROFISSIONAL+back-to-back) sempre foi e continua SEMPRE injetada, incondicional —
// isso NÃO muda. O que mudou é que o "Formato do cartão" (estilo/emojis) agora segue
// SEMPRE a área, sem exceção pra persona custom (era o ramo prompt_custom=false).
describe('buildCartaoEstabelecimentoBlock — assinatura pós-ADR-0035', () => {
  it('assinatura aceita só 1 argumento (promptCustom removido, SCRUM-85 sticky morreu)', () => {
    // @ts-expect-error — 2º argumento não existe mais na assinatura.
    expect(buildCartaoEstabelecimentoBlock('manicure', true)).toContain('💅 SERVICO');
  });

  it('regra ESTRUTURAL inegociável presente em toda área (invariante intocada)', () => {
    for (const area of ['barbearia', 'manicure', 'outro', null]) {
      const block = buildCartaoEstabelecimentoBlock(area);
      expect(block).toMatch(/CADA agendamento/i);
      expect(block).toMatch(/SÓ DEPOIS do SIM, chamar inserir_agendamento/);
      expect(block).toMatch(/Responda SIM/i);
      expect(block).toMatch(/back-to-back|mesma conversa/i);
      expect(block).toMatch(/NUNCA pule o cartão|NUNCA agende\s+direto/i);
      expect(block).toContain('nome que está em [PROFISSIONAIS]');
    }
  });
});
