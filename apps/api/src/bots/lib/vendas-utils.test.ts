import { describe, expect, it } from 'vitest';
import { formatPrice, parseConversationState, parseMarker, sanitizar } from './vendas-utils.js';

describe('parseMarker', () => {
  it('retorna null quando não há marcador', () => {
    const result = parseMarker('Olá, posso ajudar?');
    expect(result.type).toBeNull();
    expect(result.clean).toBe('Olá, posso ajudar?');
  });

  it('extrai LISTA_CURSOS e limpa o texto', () => {
    const result = parseMarker('Temos ótimas opções:\n[LISTA_CURSOS]');
    expect(result.type).toBe('LISTA_CURSOS');
    expect(result.clean).toBe('Temos ótimas opções:');
  });

  it('extrai CURSO com slug', () => {
    const result = parseMarker('Aqui está o curso!\n[CURSO:curso-online-degrade]');
    expect(result.type).toBe('CURSO');
    expect(result.courseSlug).toBe('curso-online-degrade');
  });

  it('extrai VIDEO com id numérico', () => {
    const result = parseMarker('Assista:\n[VIDEO:42]');
    expect(result.type).toBe('VIDEO');
    expect(result.mediaId).toBe(42);
  });

  it('extrai VIDEOS_CURSO', () => {
    const result = parseMarker('Aqui estão todos os vídeos:\n[VIDEOS_CURSO]');
    expect(result.type).toBe('VIDEOS_CURSO');
  });
});

describe('parseConversationState', () => {
  it('retorna estado vazio para histórico sem system markers', () => {
    const state = parseConversationState([{ role: 'user', content: 'oi' }]);
    expect(state.cursoEscolhido).toBeNull();
    expect(state.mediaIdsSentSet.size).toBe(0);
  });

  it('extrai CURSO_ESCOLHIDO do histórico', () => {
    const history = [{ role: 'system', content: '[STATE:CURSO_ESCOLHIDO:curso-presencial]' }];
    const state = parseConversationState(history);
    expect(state.cursoEscolhido).toBe('curso-presencial');
  });

  it('extrai múltiplos VIDEO_SENT do histórico', () => {
    const history = [{ role: 'system', content: '[STATE:VIDEO_SENT:10] [STATE:VIDEO_SENT:20]' }];
    const state = parseConversationState(history);
    expect(state.mediaIdsSentSet.has(10)).toBe(true);
    expect(state.mediaIdsSentSet.has(20)).toBe(true);
  });
});

describe('formatPrice', () => {
  it('converte centavos para R$ com vírgula decimal', () => {
    expect(formatPrice(9900)).toBe('R$99,00');
    expect(formatPrice(150050)).toBe('R$1500,50');
  });
});

describe('sanitizar', () => {
  it('remove linhas com prefixo to=functions.', () => {
    const input = 'Resposta ok\nto=functions.run()\nFim';
    expect(sanitizar(input)).toBe('Resposta ok\nFim');
  });

  it('remove linhas que são apenas JSON objeto', () => {
    const input = 'Ok\n{"key":"value"}\nFim';
    expect(sanitizar(input)).toBe('Ok\nFim');
  });

  it('preserva linhas normais e linhas vazias', () => {
    const input = 'Linha 1\n\nLinha 2';
    expect(sanitizar(input)).toBe('Linha 1\n\nLinha 2');
  });
});
