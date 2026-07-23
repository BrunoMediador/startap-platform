import { describe, expect, it } from 'vitest';
import {
  COPY_PRIMEIRA_CONEXAO,
  COPY_RECONEXAO,
  isPrimeiraConexao,
  resolveConexaoCardCopy,
} from './conexao-copy';

// Harness pure-fn do portal (sem RTL/jsdom): cobre o CONTRATO da copy de conexao
// do SCRUM-95 — qual moldura verbal dado o sinal `ever_connected` (1a conexao vs
// reconexao), com destaque para o default seguro (undefined = reconexao) e a
// GARANTIA byte-identica da reconexao (tem cliente pagante em producao).

describe('resolveConexaoCardCopy — 1a conexao vs reconexao', () => {
  it('ever_connected=false (nunca pareou) -> copy de PRIMEIRA conexao (positiva)', () => {
    expect(resolveConexaoCardCopy(false)).toBe(COPY_PRIMEIRA_CONEXAO);
  });

  it('ever_connected=true (ja pareou e caiu) -> copy de RECONEXAO', () => {
    expect(resolveConexaoCardCopy(true)).toBe(COPY_RECONEXAO);
  });

  it('ever_connected=undefined (backend ainda nao expoe) -> RECONEXAO (default seguro)', () => {
    // Regra dura do SCRUM-95: sem o sinal, NUNCA chamar um cliente real de
    // "primeira vez". O default preserva a producao byte-a-byte.
    expect(resolveConexaoCardCopy(undefined)).toBe(COPY_RECONEXAO);
  });
});

describe('COPY_RECONEXAO — byte-identica a producao (nao regredir)', () => {
  // Golden literal: se alguem mexer nestes textos, o teste quebra. E o contrato
  // do card: o cliente que ja conectou le EXATAMENTE o que lia antes do SCRUM-95.
  it('mantem titulo/cta/loading/hint atuais palavra por palavra', () => {
    expect(COPY_RECONEXAO).toEqual({
      title: 'Seu WhatsApp se desconectou. Vamos reconectar.',
      cta: 'Reconectar WhatsApp',
      ctaLoading: 'Reconectando…',
      hint: 'Vai levar alguns segundos. Deixe essa tela aberta.',
    });
  });
});

describe('COPY_PRIMEIRA_CONEXAO — onboarding positivo (sem "desconectou/reconectar")', () => {
  it('nao usa palavras de "quebrou" (desconect*/reconect*) em nenhum texto', () => {
    const textos = [
      COPY_PRIMEIRA_CONEXAO.title,
      COPY_PRIMEIRA_CONEXAO.cta,
      COPY_PRIMEIRA_CONEXAO.ctaLoading,
      COPY_PRIMEIRA_CONEXAO.hint,
    ].join(' ');
    expect(textos.toLowerCase()).not.toMatch(/desconect|reconect/);
  });

  it('CTA e o verbo positivo "Conectar"', () => {
    expect(COPY_PRIMEIRA_CONEXAO.cta).toBe('Conectar WhatsApp');
    expect(COPY_PRIMEIRA_CONEXAO.ctaLoading).toBe('Conectando…');
  });
});

describe('isPrimeiraConexao — mesma regra do default seguro', () => {
  it('so `false` explicito e primeira conexao', () => {
    expect(isPrimeiraConexao(false)).toBe(true);
    expect(isPrimeiraConexao(true)).toBe(false);
    expect(isPrimeiraConexao(undefined)).toBe(false);
  });
});
