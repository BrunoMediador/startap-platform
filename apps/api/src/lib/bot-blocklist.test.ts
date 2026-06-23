/**
 * Testa a blocklist GLOBAL de números internos (Missão 023 — fix do cancelamento;
 * repoint do default pós-023: remetente da ALERTAS mudou de 7411 -> 553598373138).
 *
 * Caminhos cobertos:
 *  - default (sem env) bloqueia o remetente ATUAL da ALERTAS (553598373138), com e sem 9.
 *  - o número ANTIGO 7411 (553599247411) foi LIBERADO — NÃO é mais bloqueado pelo default
 *    (Bruno vai reusá-lo; o bot precisa poder interagir com ele).
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

  it('bloqueia o remetente atual da ALERTAS (553598373138)', () => {
    expect(DEFAULT_BLOCKLIST_NUMBER).toBe('553598373138');
    expect(isBlocked(DEFAULT_BLOCKLIST_NUMBER)).toBe(true);
    expect(isBlocked('553598373138')).toBe(true);
  });

  it('bloqueia a ALERTAS mesmo com máscara/sufixo (chatId) e com o 9º dígito', () => {
    expect(isBlocked('553598373138@c.us')).toBe(true);
    expect(isBlocked('+55 (35) 9837-3138')).toBe(true);
    expect(isBlocked('5535998373138')).toBe(true); // com 9 -> canônico bate
  });

  it('LIBERA o número antigo 7411 (553599247411) — não é mais remetente de alerta', () => {
    expect(isBlocked('553599247411')).toBe(false);
    expect(isBlocked('553599247411@c.us')).toBe(false);
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
  it('adiciona números da env (CSV) mantendo o default (remetente ALERTAS)', () => {
    const isBlocked = __buildBlocklistForTest('553511112222, 553533334444');
    // default segue valendo
    expect(isBlocked('553598373138')).toBe(true);
    // novos da env
    expect(isBlocked('553511112222')).toBe(true);
    expect(isBlocked('553533334444')).toBe(true);
    // fora da lista passa
    expect(isBlocked('5535999990000')).toBe(false);
    // time do Bruno continua liberado mesmo com env custom
    expect(isBlocked('5519981018908')).toBe(false);
    // 7411 segue liberado (não está no default nem na env)
    expect(isBlocked('553599247411')).toBe(false);
  });

  it('a env PODE re-bloquear o 7411 explicitamente (se um dia for preciso)', () => {
    const isBlocked = __buildBlocklistForTest('553599247411');
    expect(isBlocked('553599247411')).toBe(true);
    // e o default da ALERTAS continua valendo junto
    expect(isBlocked('553598373138')).toBe(true);
  });

  it('tolera 9º dígito BR: bloqueia número da env com e sem o 9', () => {
    // env com a forma SEM 9 (12 dígitos); mensagem chega COM 9 (13 dígitos)
    const isBlocked = __buildBlocklistForTest('553533334444');
    expect(isBlocked('553533334444')).toBe(true); // sem 9
    expect(isBlocked('5535933334444')).toBe(true); // com 9 -> canônico bate
  });

  it('env vazia -> comporta-se como default', () => {
    const isBlocked = __buildBlocklistForTest('   ');
    expect(isBlocked('553598373138')).toBe(true);
    expect(isBlocked('553599247411')).toBe(false);
    expect(isBlocked('5535999990000')).toBe(false);
  });
});

describe('bot-blocklist — export real (isBlockedNumber, sem env no teste)', () => {
  it('bloqueia o default (ALERTAS) e libera cliente comum e o 7411 antigo', () => {
    expect(isBlockedNumber('553598373138')).toBe(true);
    expect(isBlockedNumber('553599247411')).toBe(false);
    expect(isBlockedNumber('5535999990000')).toBe(false);
  });
});
