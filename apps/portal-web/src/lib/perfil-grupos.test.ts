import { describe, expect, it } from 'vitest';
import { PERFIL_GRUPOS, type SecaoKey, TODAS_SECOES, grupoDaSecao } from './perfil-grupos';

// Todas as seções que a tela "Meu negócio" renderiza hoje. Se uma seção nova
// entrar (ou sair), ESTE teste falha primeiro — força atualizar o mapa de grupos
// junto, evitando seção órfã fora dos 3 blocos.
const ESPERADAS: SecaoKey[] = [
  'dados-negocio',
  'planos',
  'recepcao',
  'monte-assistente',
  'tom',
  'cartao',
  'faq',
  'agendamento',
  'lembretes',
  'google-agenda',
];

describe('perfil-grupos', () => {
  it('tem exatamente 3 grupos, na ordem dados → personalidade → agenda', () => {
    expect(PERFIL_GRUPOS.map((g) => g.key)).toEqual(['dados', 'personalidade', 'agenda']);
  });

  it('cada grupo tem âncora, chip, título e subtítulo não-vazios', () => {
    for (const g of PERFIL_GRUPOS) {
      expect(g.anchorId).toBe(`grupo-${g.key}`);
      expect(g.chip.trim().length).toBeGreaterThan(0);
      expect(g.titulo.trim().length).toBeGreaterThan(0);
      expect(g.subtitulo.trim().length).toBeGreaterThan(0);
      expect(g.secoes.length).toBeGreaterThan(0);
    }
  });

  it('âncoras são únicas (chips não colidem)', () => {
    const anchors = PERFIL_GRUPOS.map((g) => g.anchorId);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('cobre TODAS as seções da tela, sem duplicar nenhuma (mapa completo)', () => {
    // Sem duplicatas.
    expect(new Set(TODAS_SECOES).size).toBe(TODAS_SECOES.length);
    // Mesmo conjunto (ordem à parte) do que a página renderiza.
    expect([...TODAS_SECOES].sort()).toEqual([...ESPERADAS].sort());
    // Contagem bate — nenhuma seção sobrou nem faltou.
    expect(TODAS_SECOES.length).toBe(ESPERADAS.length);
  });

  it('ordem das seções dentro de cada grupo está travada', () => {
    expect(PERFIL_GRUPOS[0].secoes).toEqual(['dados-negocio', 'planos', 'recepcao']);
    expect(PERFIL_GRUPOS[1].secoes).toEqual(['monte-assistente', 'tom', 'cartao', 'faq']);
    expect(PERFIL_GRUPOS[2].secoes).toEqual(['agendamento', 'lembretes', 'google-agenda']);
  });

  it('grupoDaSecao resolve cada seção pro grupo certo', () => {
    expect(grupoDaSecao('dados-negocio')).toBe('dados');
    expect(grupoDaSecao('planos')).toBe('dados');
    expect(grupoDaSecao('recepcao')).toBe('dados');
    expect(grupoDaSecao('monte-assistente')).toBe('personalidade');
    expect(grupoDaSecao('tom')).toBe('personalidade');
    expect(grupoDaSecao('cartao')).toBe('personalidade');
    expect(grupoDaSecao('faq')).toBe('personalidade');
    expect(grupoDaSecao('agendamento')).toBe('agenda');
    expect(grupoDaSecao('lembretes')).toBe('agenda');
    expect(grupoDaSecao('google-agenda')).toBe('agenda');
  });

  it('cada seção esperada pertence a algum grupo', () => {
    for (const s of ESPERADAS) {
      expect(grupoDaSecao(s)).toBeDefined();
    }
  });
});
