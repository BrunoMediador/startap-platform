/**
 * Guarda do conteúdo legal publicado (SCRUM-1). Não valida juridiquês — garante que
 * o texto v1 está LIMPO: sem placeholder/nota interna, CPF só mascarado, versões
 * sincronizadas e estrutura íntegra. Pega regressão de "esqueci de tirar o marcador".
 */
import { describe, expect, it } from 'vitest';
import {
  type LegalBlock,
  type LegalDocument,
  POLITICA_PRIVACIDADE,
  PRIVACY_VERSION,
  TERMOS_DE_USO,
  TERMS_VERSION,
} from './legal';

/** Concatena TODO o texto renderável de um documento (intro + seções + blocos). */
function flatten(doc: LegalDocument): string {
  const fromBlock = (b: LegalBlock): string => {
    switch (b.kind) {
      case 'p':
      case 'sub':
      case 'callout':
        return b.text;
      case 'ul':
        return b.items.join(' ');
      case 'table':
        return [...b.columns, ...b.rows.flat()].join(' ');
    }
  };
  const parts = [doc.title, ...doc.intro.map(fromBlock)];
  for (const s of doc.sections) {
    parts.push(s.heading, ...s.blocks.map(fromBlock));
  }
  return parts.join('\n');
}

const DOCS: Array<[string, LegalDocument]> = [
  ['Termos de Uso', TERMOS_DE_USO],
  ['Política de Privacidade', POLITICA_PRIVACIDADE],
];

describe.each(DOCS)('conteúdo legal limpo: %s', (_name, doc) => {
  const text = flatten(doc);

  it('não sobra nenhum marcador de placeholder', () => {
    expect(text).not.toMatch(/\{\{/);
    expect(text).not.toMatch(/\[PREENCHER/i);
    expect(text).not.toMatch(/PLACEHOLDER/i);
  });

  it('não vaza nota interna / status de rascunho', () => {
    expect(text).not.toMatch(/nota\s*\(interno/i);
    expect(text).not.toMatch(/nota de risco/i);
    expect(text).not.toMatch(/nota de decisão/i);
    expect(text).not.toMatch(/remover antes de publicar/i);
    expect(text).not.toMatch(/RASCUNHO JUR/i);
  });

  it('CPF aparece SÓ mascarado — nunca o completo', () => {
    expect(text).toContain('136.***.***-70');
    expect(text).not.toContain('136.626.806-70');
  });

  it('identifica o prestador e o foro corretos', () => {
    expect(text).toContain('Bruno Silva Corrêa');
    expect(text).toContain('Itajubá/MG');
    expect(text).toContain('startapsuporte@gmail.com');
  });

  it('data de vigência preenchida (formato DD/MM/AAAA, não é token)', () => {
    expect(doc.updatedAt).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});

describe('versões sincronizadas (Termos v1, Política v2)', () => {
  it('cada doc bate com sua constante de versão', () => {
    // Política foi pra v2 no append da finalidade (SCRUM-59); Termos seguem v1.
    expect(TERMS_VERSION).toBe('v1');
    expect(PRIVACY_VERSION).toBe('v2');
    expect(TERMOS_DE_USO.version).toBe(TERMS_VERSION);
    expect(POLITICA_PRIVACIDADE.version).toBe(PRIVACY_VERSION);
  });
});

describe('defaults aplicados (decisão Bruno/PM)', () => {
  const termos = flatten(TERMOS_DE_USO);
  const privacidade = flatten(POLITICA_PRIVACIDADE);

  it('tolerância de inadimplência = 5 dias e aviso de reajuste = 30 dias', () => {
    expect(termos).toContain('após 5 dias');
    expect(termos).toContain('aviso prévio de 30 dias');
  });

  it('cookies só os necessários (sem ressalva de analytics em aberto)', () => {
    expect(privacidade).toContain('apenas cookies estritamente necessários');
    expect(privacidade).not.toMatch(/há cookies de analytics/i);
  });

  it('região do datacenter da VPS genérica ("a confirmar", sem afirmar país)', () => {
    expect(privacidade).toContain('a confirmar');
  });
});
