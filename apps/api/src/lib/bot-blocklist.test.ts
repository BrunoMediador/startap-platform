/**
 * Testa a blocklist GLOBAL de números internos (Missão 023 — fix do cancelamento).
 *
 * Caminhos cobertos:
 *  - default (sem env) bloqueia o 7411 (553599247411), com e sem 9º dígito.
 *  - número normal de cliente passa.
 *  - números do TIME/teste do Bruno (5519981018908, 553598877248) NÃO são bloqueados.
 *  - env BOT_BLOCKLIST_NUMBERS adiciona outros números (CSV), mantendo o default.
 *
 * Usa __buildBlocklistForTest p/ exercitar valores de env sem recarregar o módulo.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCKLIST_NUMBER,
  __buildBlocklistForTest,
  isBlockedNumber,
} from './bot-blocklist.js';

describe('bot-blocklist — default (sem env)', () => {
  const isBlocked = __buildBlocklistForTest(undefined);

  it('bloqueia o número interno padrão (7411 / 553599247411)', () => {
    expect(isBlocked(DEFAULT_BLOCKLIST_NUMBER)).toBe(true);
    expect(isBlocked('553599247411')).toBe(true);
  });

  it('bloqueia o 7411 mesmo com máscara/sufixo (chatId)', () => {
    expect(isBlocked('553599247411@c.us')).toBe(true);
    expect(isBlocked('+55 (35) 99247-411')).toBe(true);
  });

  it('NÃO bloqueia número normal de cliente', () => {
    expect(isBlocked('5535999990000')).toBe(false);
    expect(isBlocked('5511912345678')).toBe(false);
  });

  it('NÃO bloqueia os números do TIME/teste do Bruno', () => {
    expect(isBlocked('5519981018908')).toBe(false);
    expect(isBlocked('553598877248')).toBe(false);
  });

  it('entrada vazia/curta -> não bloqueia (não trava por lixo)', () => {
    expect(isBlocked('')).toBe(false);
    expect(isBlocked('123')).toBe(false);
  });
});

describe('bot-blocklist — env BOT_BLOCKLIST_NUMBERS', () => {
  it('adiciona números da env (CSV) mantendo o default 7411', () => {
    const isBlocked = __buildBlocklistForTest('553511112222, 553533334444');
    // default segue valendo
    expect(isBlocked('553599247411')).toBe(true);
    // novos da env
    expect(isBlocked('553511112222')).toBe(true);
    expect(isBlocked('553533334444')).toBe(true);
    // fora da lista passa
    expect(isBlocked('5535999990000')).toBe(false);
    // time do Bruno continua liberado mesmo com env custom
    expect(isBlocked('5519981018908')).toBe(false);
  });

  it('tolera 9º dígito BR: bloqueia número da env com e sem o 9', () => {
    // env com a forma SEM 9 (12 dígitos); mensagem chega COM 9 (13 dígitos)
    const isBlocked = __buildBlocklistForTest('553533334444');
    expect(isBlocked('553533334444')).toBe(true); // sem 9
    expect(isBlocked('5535933334444')).toBe(true); // com 9 -> canônico bate
  });

  it('env vazia -> comporta-se como default', () => {
    const isBlocked = __buildBlocklistForTest('   ');
    expect(isBlocked('553599247411')).toBe(true);
    expect(isBlocked('5535999990000')).toBe(false);
  });
});

describe('bot-blocklist — export real (isBlockedNumber, sem env no teste)', () => {
  it('bloqueia o default e libera cliente comum', () => {
    expect(isBlockedNumber('553599247411')).toBe(true);
    expect(isBlockedNumber('5535999990000')).toBe(false);
  });
});
