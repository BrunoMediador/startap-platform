/**
 * Guarda de preservação do modo MELHORIA (SCRUM-153).
 *
 * O que ela protege: no modo melhoria o approve SOBRESCREVE o bot_prompt inteiro, então uma
 * proposta que voltou pela metade faz o dono PERDER texto que ele nunca pediu pra remover
 * (regra de negócio 27). Aqui provamos os 3 comportamentos: encolhimento grosseiro barra,
 * ajuste normal passa, e pedido explícito de reescrita desliga a guarda.
 */
import { describe, expect, it } from 'vitest';
import { PRESERVACAO_MIN_RATIO, avaliarPreservacao } from './prompt-builder-preservacao.js';

const PERSONA_ATUAL = [
  'Você é a assistente do consultório e fala com acolhimento e calma.',
  'Trate cada pessoa com respeito e sem pressa, chamando pelo nome quando souber.',
  'Não faça diagnóstico nem prometa resultado de tratamento.',
  'Se a pessoa pedir para remarcar, seja compreensiva e encaminhe para a profissional.',
  'Mantenha sempre um tom educado, paciente e reservado.',
].join('\n');

describe('avaliarPreservacao', () => {
  it('ACRÉSCIMO (persona atual + linha nova) passa', () => {
    const proposta = `${PERSONA_ATUAL}\nSe perguntarem sobre atendimento infantil, explique que não é atendido aqui.`;
    expect(avaliarPreservacao(PERSONA_ATUAL, proposta).ok).toBe(true);
  });

  it('reformulação de mesmo porte passa (a guarda não policia estilo)', () => {
    const proposta = PERSONA_ATUAL.replace(
      'acolhimento e calma',
      'muito acolhimento e bastante calma',
    );
    expect(avaliarPreservacao(PERSONA_ATUAL, proposta).ok).toBe(true);
  });

  it('remoção PEQUENA pedida pelo dono passa (tirar uma linha não é perder a persona)', () => {
    const proposta = PERSONA_ATUAL.split('\n').slice(0, 4).join('\n');
    expect(avaliarPreservacao(PERSONA_ATUAL, proposta).ok).toBe(true);
  });

  it('BARRA o modo de falha real: modelo devolve só o trecho novo', () => {
    const r = avaliarPreservacao(PERSONA_ATUAL, 'Você é a assistente e não atende criança.');
    expect(r.ok).toBe(false);
    expect(r.ratio).toBeLessThan(PRESERVACAO_MIN_RATIO);
  });

  it('BARRA truncagem no meio (resposta cortada)', () => {
    expect(avaliarPreservacao(PERSONA_ATUAL, PERSONA_ATUAL.slice(0, 60)).ok).toBe(false);
  });

  it('reescrita EXPLÍCITA desliga a guarda (o dono pediu pra trocar o texto)', () => {
    const r = avaliarPreservacao(PERSONA_ATUAL, 'Persona nova, curta e direta.', true);
    expect(r.ok).toBe(true);
  });

  it('modo CRIAÇÃO (sem persona atual) nunca é barrado', () => {
    expect(avaliarPreservacao('', 'qualquer persona nova gerada do zero').ok).toBe(true);
  });

  it('persona atual curta demais não entra na conta (ruído)', () => {
    expect(avaliarPreservacao('Você é a assistente.', 'Oi.').ok).toBe(true);
  });

  it('ratio é reportado pra log (observabilidade sem expor o texto)', () => {
    const r = avaliarPreservacao(PERSONA_ATUAL, PERSONA_ATUAL);
    expect(r.ratio).toBe(1);
  });
});
