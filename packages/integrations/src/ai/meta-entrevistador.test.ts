/**
 * Testes do meta-entrevistador (SCRUM-92 + v3 20/07).
 *
 * 1. DRIFT-GUARD: cada const executável tem que bater byte-a-byte com o corpo do `.md`
 *    versionado (fonte canônica) — impede que a persona do entrevistador divirja
 *    silenciosamente do que está documentado/aprovado. V1/V2 são imutáveis (histórico);
 *    V3 é a versão EXECUTADA em runtime.
 * 2. O builder preenche o contexto do clone (nome/área/modo) e o input do cliente NUNCA
 *    entra no system prompt.
 * 3. A v3 (20/07) está no prompt executado: humanizado (poucas perguntas, não obriga),
 *    GERAR SOB DEMANDA, redirecionamento de dados operacionais e aviso final (rolar a tela +
 *    Aprovar/Rejeitar/Editar).
 * 4. matchesGenerateIntent: casa "pode gerar/terminei/pronto..." sem falso positivo por substring.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  META_ENTREVISTADOR_PROMPT_V1,
  META_ENTREVISTADOR_PROMPT_V2,
  META_ENTREVISTADOR_PROMPT_V3,
  buildEntrevistadorSystemPrompt,
  matchesGenerateIntent,
  primeiraPergunta,
} from './meta-entrevistador.js';

function readMdBody(version: 'v1' | 'v2' | 'v3'): string {
  const path = fileURLToPath(
    new URL(`../../ai/prompts/meta-entrevistador/${version}.md`, import.meta.url),
  );
  const md = readFileSync(path, 'utf8');
  // O corpo é tudo depois da primeira linha separadora `---` isolada.
  const parts = md.split(/\n---\n/);
  return parts[parts.length - 1].trim();
}

describe('meta-entrevistador — drift guard', () => {
  it('const V1 == corpo do v1.md (fonte canônica imutável)', () => {
    expect(META_ENTREVISTADOR_PROMPT_V1.trim()).toBe(readMdBody('v1'));
  });

  it('const V2 == corpo do v2.md (fonte canônica imutável)', () => {
    expect(META_ENTREVISTADOR_PROMPT_V2.trim()).toBe(readMdBody('v2'));
  });

  it('const V3 (runtime) == corpo do v3.md (fonte canônica)', () => {
    expect(META_ENTREVISTADOR_PROMPT_V3.trim()).toBe(readMdBody('v3'));
  });
});

describe('meta-entrevistador — v3 20/07 (V3 é o runtime)', () => {
  it('o system prompt executado carrega tom de consultor, gerar sob demanda, redirecionamento e aviso final', () => {
    const sp = buildEntrevistadorSystemPrompt({
      nomeNegocio: 'Barbearia do Zé',
      area: 'barbearia',
      modo: 'agenda',
    });
    // Tom profissional (v3 mantém: sem gírias/emojis) + consultor de configuração.
    expect(sp).toContain('consultor de configuração');
    expect(sp).toContain('Sem gírias, sem emojis');
    // v3: GERAR SOB DEMANDA (o fix central) — o dono pode pedir pra gerar quando quiser.
    expect(sp).toContain('GERAR SOB DEMANDA');
    expect(sp).toContain('pode pedir para gerar a qualquer momento');
    // Redirecionar dados operacionais para a tela certa.
    expect(sp).toContain('Horário de atendimento');
    expect(sp).toContain('Meu negócio');
    expect(sp).toContain('catálogo de serviços');
    // Aviso final: rolar a tela + Aprovar/Rejeitar/Editar.
    expect(sp).toContain('ROLAR A TELA PARA BAIXO');
    expect(sp).toMatch(/Aprovar, Rejeitar ou Editar/);
    // Placeholders todos resolvidos.
    expect(sp).not.toContain('{area}');
    expect(sp).not.toContain('{modo}');
  });
});

describe('matchesGenerateIntent', () => {
  it('casa intenção clara de gerar (lista do v3)', () => {
    for (const t of [
      'pode gerar',
      'Pode gerar!',
      'pode gerar a persona agora',
      'gera',
      'gerar',
      'gere isso',
      'terminei',
      'acho que é isso, pode gerar',
      'pronto',
      'chega',
      'é isso',
      'só isso',
      'manda',
      'pode montar',
      'finaliza',
    ]) {
      expect(matchesGenerateIntent(t), t).toBe(true);
    }
  });

  it('NÃO casa por substring nem em conversa normal (sem falso positivo)', () => {
    for (const t of [
      'quero que ele fale de forma descontraída',
      'geralmente meus clientes marcam de manhã',
      'atendo prontamente toda semana',
      'ele deve ser acolhedor e calmo',
      'não sei, você decide',
      'ele não passa orçamento por foto',
    ]) {
      expect(matchesGenerateIntent(t), t).toBe(false);
    }
  });

  it('string vazia -> false', () => {
    expect(matchesGenerateIntent('')).toBe(false);
    expect(matchesGenerateIntent('   ')).toBe(false);
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
    expect(sp).toContain('chamar o dono ou outro atendente humano');
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

  it('primeiraPergunta é determinística, cita o negócio e tem tom profissional', () => {
    const q = primeiraPergunta({ nomeNegocio: 'Salão Lua', area: 'salao', modo: 'agenda' });
    expect(q).toContain('Salão Lua');
    expect(q).toMatch(/como você quer que ele fale/i);
    // Sem a gíria da v1 ("com a cara de vocês" / "perguntinhas").
    expect(q).not.toContain('com a cara de vocês');
    expect(q).not.toContain('perguntinhas');
  });
});
