/**
 * Testes da extração VERBATIM do cartão baked (script de migração — SCRUM-92 inc.2).
 * Prova: bloco estrutural e seção [CARTAO DE CONFIRMACAO] extraídos byte-a-byte quando TRAILING;
 * cartão no MEIO (interwoven) ou ausente → found:false (clone NÃO migrável, fica baked).
 */
import { describe, expect, it } from 'vitest';
import { buildBlocoEstrutural } from './bloco-estrutural.js';
import { extractBakedCartao } from './cartao-extract.js';

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
