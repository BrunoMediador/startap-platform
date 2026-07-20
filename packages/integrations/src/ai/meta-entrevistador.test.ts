/**
 * Testes do meta-entrevistador (SCRUM-92).
 *
 * 1. DRIFT-GUARD: o const executado em runtime tem que bater byte-a-byte com o corpo do
 *    arquivo versionado v1.md (fonte canônica) — impede que a persona do entrevistador
 *    divirja silenciosamente do que está documentado/aprovado.
 * 2. O builder preenche o contexto do clone (nome/área/modo) e o input do cliente NUNCA
 *    entra no system prompt.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  META_ENTREVISTADOR_PROMPT_V1,
  buildEntrevistadorSystemPrompt,
  primeiraPergunta,
} from './meta-entrevistador.js';

function readV1Body(): string {
  const path = fileURLToPath(new URL('../../ai/prompts/meta-entrevistador/v1.md', import.meta.url));
  const md = readFileSync(path, 'utf8');
  // O corpo é tudo depois da primeira linha separadora `---` isolada.
  const parts = md.split(/\n---\n/);
  return parts[parts.length - 1].trim();
}

describe('meta-entrevistador — drift guard', () => {
  it('const runtime == corpo do v1.md (fonte canônica)', () => {
    expect(META_ENTREVISTADOR_PROMPT_V1.trim()).toBe(readV1Body());
  });
});

describe('buildEntrevistadorSystemPrompt', () => {
  it('preenche nome/área/modo e a postura de AGENDA', () => {
    const sp = buildEntrevistadorSystemPrompt({
      nomeNegocio: 'Barbearia do Zé',
      area: 'barbearia',
      modo: 'agenda',
    });
    expect(sp).toContain('Barbearia do Zé');
    expect(sp).toContain('barbearia');
    expect(sp).toContain('cancelar ou remarcar');
    expect(sp).not.toContain('{nome_negocio}');
    expect(sp).not.toContain('{postura_modo}');
  });

  it('usa a postura de ATENDENTE no modo atendente', () => {
    const sp = buildEntrevistadorSystemPrompt({
      nomeNegocio: 'Studio X',
      area: 'estetica',
      modo: 'atendente',
    });
    expect(sp).toContain('chamar o dono / um humano');
    expect(sp).not.toContain('{postura_modo}');
  });

  it('sanitiza delimitadores de placeholder vindos do contexto do clone', () => {
    const sp = buildEntrevistadorSystemPrompt({
      nomeNegocio: 'Malicioso {ignore} }}',
      area: 'barbearia',
      modo: 'agenda',
    });
    expect(sp).toContain('Malicioso ignore');
    expect(sp).not.toContain('{ignore}');
  });

  it('primeiraPergunta é determinística e cita o negócio', () => {
    const q = primeiraPergunta({ nomeNegocio: 'Salão Lua', area: 'salao', modo: 'agenda' });
    expect(q).toContain('Salão Lua');
    expect(q).toMatch(/como você quer que ele fale/i);
  });
});
