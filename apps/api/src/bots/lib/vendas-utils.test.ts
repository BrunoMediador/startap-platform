import { describe, expect, it } from 'vitest';
import { formatCoursesForPrompt, formatPrice, parseConversationState, parseMarker, sanitizar } from './vendas-utils.js';

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

describe('formatCoursesForPrompt', () => {
  const BASE_COURSE = {
    id: 1,
    slot: 'slot-test',
    course_slug: 'curso-presencial',
    name: 'Curso Presencial',
    description: null,
    price: 150000,
    duration: 'Presencial, 3 meses',
    position_order: 0,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    details_for_llm: null,
  };

  it('retorna fallback quando lista vazia', () => {
    expect(formatCoursesForPrompt([])).toBe('(nenhum curso cadastrado)');
  });

  it('renderiza curso sem details_for_llm com header + slug apenas', () => {
    const result = formatCoursesForPrompt([BASE_COURSE]);
    expect(result).toContain('Curso Presencial (R$1500,00) Presencial, 3 meses');
    expect(result).toContain('  Slug: curso-presencial');
    expect(result).not.toContain('Detalhes:');
  });

  it('renderiza curso com details_for_llm incluindo bloco Detalhes', () => {
    const course = {
      ...BASE_COURSE,
      details_for_llm: 'MODALIDADE: Presencial\nDURACAO: 3 meses\nINCLUI: Apostila',
    };
    const result = formatCoursesForPrompt([course]);
    expect(result).toContain('Curso Presencial (R$1500,00) Presencial, 3 meses');
    expect(result).toContain('  Slug: curso-presencial');
    expect(result).toContain('  Detalhes:');
    expect(result).toContain('  MODALIDADE: Presencial');
    expect(result).toContain('  DURACAO: 3 meses');
  });

  it('omite curso desabilitado', () => {
    const disabled = { ...BASE_COURSE, enabled: false };
    expect(formatCoursesForPrompt([disabled])).toBe('(nenhum curso cadastrado)');
  });

  it('separa multiplos cursos com linha em branco', () => {
    const c2 = {
      ...BASE_COURSE,
      id: 2,
      course_slug: 'curso-online',
      name: 'Curso Online',
      price: 29700,
      duration: 'Online, acesso vitalicio',
    };
    const result = formatCoursesForPrompt([BASE_COURSE, c2]);
    const parts = result.split('\n\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Curso Presencial');
    expect(parts[1]).toContain('Curso Online');
  });
});
