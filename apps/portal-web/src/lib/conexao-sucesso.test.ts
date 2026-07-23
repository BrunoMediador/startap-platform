import { describe, expect, it } from 'vitest';
import { type ConexaoFormato, resolveConexaoFormato, sucessoConexaoCopy } from './conexao-sucesso';

describe('resolveConexaoFormato', () => {
  it("agenda_automatica === false -> 'atendente' (pré-venda, sem agenda)", () => {
    expect(resolveConexaoFormato({ agenda_automatica: false })).toBe('atendente');
  });

  it("agenda_automatica === true -> 'agenda'", () => {
    expect(resolveConexaoFormato({ agenda_automatica: true })).toBe('agenda');
  });

  it("degrada seguro pra 'agenda' quando o dado não carregou (undefined/null/campo ausente)", () => {
    expect(resolveConexaoFormato(undefined)).toBe('agenda');
    expect(resolveConexaoFormato(null)).toBe('agenda');
    expect(resolveConexaoFormato({})).toBe('agenda');
  });
});

describe('sucessoConexaoCopy', () => {
  it("formato 'agenda' mantém o bloco 'Falta só a sua agenda' (não regride)", () => {
    const copy = sucessoConexaoCopy('agenda');
    expect(copy.agenda).not.toBeNull();
    expect(copy.agenda?.titulo).toBe('Falta só a sua agenda');
    expect(copy.subtitulo).toContain('assistente');
  });

  it("formato 'atendente' esconde a agenda e diz que o assistente já está no ar", () => {
    const copy = sucessoConexaoCopy('atendente');
    expect(copy.agenda).toBeNull();
    expect(copy.subtitulo.toLowerCase()).toContain('no ar');
    // Termo canônico SCRUM-97 (nunca "atendente"/"robô"/"bot" na copy nova).
    expect(copy.subtitulo).toContain('assistente');
    expect(copy.subtitulo).not.toMatch(/rob[ôo]|\bbot\b/i);
  });

  it('todo formato conhecido tem subtítulo não-vazio', () => {
    const formatos: ConexaoFormato[] = ['agenda', 'atendente'];
    for (const f of formatos) {
      expect(sucessoConexaoCopy(f).subtitulo.length).toBeGreaterThan(0);
    }
  });
});
