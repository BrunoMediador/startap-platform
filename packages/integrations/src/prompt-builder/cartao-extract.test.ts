/**
 * Testes da extração VERBATIM do cartão baked (script de migração — SCRUM-92 inc.2).
 * Prova: bloco estrutural e seção [CARTAO DE CONFIRMACAO] extraídos byte-a-byte quando TRAILING;
 * cartão no MEIO (interwoven) ou ausente → found:false (clone NÃO migrável, fica baked).
 */
import { describe, expect, it } from 'vitest';
import { buildBlocoEstrutural } from './bloco-estrutural.js';
import {
  extractBakedCartao,
  isCartaoFlipSafe,
  isCartaoRuntimeFlipBlocked,
} from './cartao-extract.js';

/** Formato REAL do cartão legado de Cirilo/Samuel/mvs (dump SSH read-only 23/07): seção
 *  [CARTAO DE CONFIRMACAO] SEM o marcador novo ===== REGRAS, arte 💈 + DIA/HORARIO/SERVICO/
 *  VALOR + "Responda SIM", TRAILING no bot_prompt. Byte-fiel ao que roda em produção. */
const PERSONA_LEGADO = [
  'Voce e o assistente virtual da Barbearia Samuel.',
  'Atenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.',
  '',
  '[FLUXO OBRIGATORIO]',
  '4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.',
].join('\n');
const CARTAO_LEGADO = [
  '[CARTAO DE CONFIRMACAO]',
  '💈CARTAO DE CONFIRMACAO💈',
  '──────────────────────',
  '📅 DIA:',
  '⏰ HORARIO:',
  '✂️ SERVICO:',
  '💰 VALOR:',
  '──────────────────────',
  '✅ Responda SIM para confirmar.',
].join('\n');
const BAKED_LEGADO = `${PERSONA_LEGADO}\n\n${CARTAO_LEGADO}`;

describe('extractBakedCartao — estratégia bloco (persona gerada)', () => {
  it('extrai o BLOCO estrutural trailing verbatim; persona-only fica sem ele', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    const persona = 'Você é o atendente da Barbearia X. Simpático e direto.';
    const botPrompt = `${persona}\n\n${bloco}`;
    const ex = extractBakedCartao(botPrompt);
    expect(ex.found).toBe(true);
    if (ex.found) {
      expect(ex.strategy).toBe('bloco');
      expect(ex.cartao).toBe(bloco);
      expect(ex.personaOnly).toBe(persona);
      // Recombinação preserva o cartão exato.
      expect(`${ex.personaOnly}\n\n${ex.cartao}`).toBe(botPrompt);
    }
  });

  it('bloco NÃO-trailing (há texto depois do rodapé) → não migrável', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    const botPrompt = `persona\n\n${bloco}\n\n[OUTRA COISA]\nlinha`;
    const ex = extractBakedCartao(botPrompt);
    expect(ex.found).toBe(false);
    if (!ex.found) expect(ex.reason).toBe('cartao_nao_trailing');
  });
});

describe('extractBakedCartao — estratégia template (Cirilo/Samuel)', () => {
  const TEMPLATE = [
    'Voce e o assistente virtual de uma barbearia.',
    '',
    '[FLUXO OBRIGATORIO]',
    '4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.',
    '',
    '[CARTAO DE CONFIRMACAO]',
    '💈 <nome>',
    'DIA / HORARIO / SERVICO / VALOR e pede SIM.',
  ].join('\n');

  it('extrai a seção [CARTAO DE CONFIRMACAO] trailing verbatim', () => {
    const ex = extractBakedCartao(TEMPLATE);
    expect(ex.found).toBe(true);
    if (ex.found) {
      expect(ex.strategy).toBe('template');
      expect(ex.cartao).toBe(
        [
          '[CARTAO DE CONFIRMACAO]',
          '💈 <nome>',
          'DIA / HORARIO / SERVICO / VALOR e pede SIM.',
        ].join('\n'),
      );
      // A persona-only mantém o [FLUXO] (que referencia o cartão) — refs seguem, cartão é injetado.
      expect(ex.personaOnly).toContain('[FLUXO OBRIGATORIO]');
      expect(ex.personaOnly).not.toContain('[CARTAO DE CONFIRMACAO]');
    }
  });

  it('cartão no MEIO (outra seção depois) → não-trailing → não migrável', () => {
    const interwoven = [
      'persona',
      '[CARTAO DE CONFIRMACAO]',
      'DIA / HORARIO',
      '',
      '[REGRAS FINAIS]',
      'nao invente horario',
    ].join('\n');
    const ex = extractBakedCartao(interwoven);
    expect(ex.found).toBe(false);
    if (!ex.found) expect(ex.reason).toBe('cartao_nao_trailing');
  });
});

describe('extractBakedCartao — formato REAL legado (Cirilo/Samuel/mvs em prod)', () => {
  it('separa persona↔cartão byte-a-byte; recombina no original', () => {
    const ex = extractBakedCartao(BAKED_LEGADO);
    expect(ex.found).toBe(true);
    if (ex.found) {
      expect(ex.strategy).toBe('template');
      expect(ex.cartao).toBe(CARTAO_LEGADO); // cartão verbatim (com a seção-cabeçalho)
      expect(ex.personaOnly).toBe(PERSONA_LEGADO); // persona limpa (sem o cartão)
      // A ref textual "apresente o CARTAO DE CONFIRMACAO" do [FLUXO] permanece; a arte some.
      expect(ex.personaOnly).toContain('apresente o CARTAO DE CONFIRMACAO');
      expect(ex.personaOnly).not.toContain('💈CARTAO DE CONFIRMACAO💈');
      expect(`${ex.personaOnly}\n\n${ex.cartao}`).toBe(BAKED_LEGADO);
    }
  });

  it('âncora [MODELO UNICO] (variante histórica) também é reconhecida quando trailing', () => {
    const p = 'persona real\n\n[MODELO UNICO DE CONFIRMACAO]\n💈 <nome> / DIA / pede SIM';
    const ex = extractBakedCartao(p);
    expect(ex.found).toBe(true);
    if (ex.found) expect(ex.strategy).toBe('template');
  });
});

describe('isCartaoFlipSafe — guard único do flip automático', () => {
  it('template REAL legado → flip-safe (fim do fale-com-suporte)', () => {
    expect(isCartaoFlipSafe(extractBakedCartao(BAKED_LEGADO))).toBe(true);
  });

  it('bloco gerado pelo builder → flip-safe', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    expect(isCartaoFlipSafe(extractBakedCartao(`persona real\n\n${bloco}`))).toBe(true);
  });

  it('sem cartão → NÃO flip-safe (fica locked, nunca muta)', () => {
    expect(isCartaoFlipSafe(extractBakedCartao('só persona, nenhum cartão'))).toBe(false);
  });

  it('cartão sem persona (persona-only vazia) → NÃO flip-safe', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    expect(isCartaoFlipSafe(extractBakedCartao(bloco))).toBe(false);
  });

  it('cartão NÃO-trailing → found:false → NÃO flip-safe', () => {
    const bloco = buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
    expect(isCartaoFlipSafe(extractBakedCartao(`p\n\n${bloco}\n\n[X]\ny`))).toBe(false);
  });
});

describe('extractBakedCartao — sem cartão', () => {
  it('prompt sem cartão → sem_cartao', () => {
    const ex = extractBakedCartao('só persona, nenhum cartão aqui.');
    expect(ex.found).toBe(false);
    if (!ex.found) expect(ex.reason).toBe('sem_cartao');
  });

  it('vazio → sem_cartao', () => {
    expect(extractBakedCartao('').found).toBe(false);
  });
});

// ── SCRUM-120: guard ÚNICO do flip pra runtime (endpoint + approve do builder) ──────────────
describe('isCartaoRuntimeFlipBlocked — invariante anti-cartão-duplo', () => {
  it('BLOQUEIA prompt_custom=true + baked (persona à mão, cartão no bot_prompt — caso Ingrid)', () => {
    expect(isCartaoRuntimeFlipBlocked({ promptCustom: true, cartaoMode: 'baked' })).toBe(true);
  });

  it('NÃO bloqueia clone já runtime (o flip já aconteceu; o modo não regride)', () => {
    expect(isCartaoRuntimeFlipBlocked({ promptCustom: true, cartaoMode: 'runtime' })).toBe(false);
  });

  it('NÃO bloqueia clone de template (prompt_custom=false) baked', () => {
    expect(isCartaoRuntimeFlipBlocked({ promptCustom: false, cartaoMode: 'baked' })).toBe(false);
  });

  it('NÃO bloqueia template já runtime', () => {
    expect(isCartaoRuntimeFlipBlocked({ promptCustom: false, cartaoMode: 'runtime' })).toBe(false);
  });
});
