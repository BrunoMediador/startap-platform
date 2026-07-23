/**
 * Testes do meta-entrevistador (SCRUM-92 + v3 20/07 + v4 22/07).
 *
 * 1. DRIFT-GUARD: cada const executável tem que bater byte-a-byte com o corpo do `.md`
 *    versionado (fonte canônica) — impede que a persona do entrevistador divirja
 *    silenciosamente do que está documentado/aprovado. V1/V2/V3 são imutáveis (histórico);
 *    V4 é a versão EXECUTADA em runtime.
 * 2. O builder preenche o contexto do clone (nome/área/modo) e o input do cliente NUNCA
 *    entra no system prompt.
 * 3. A v4 (22/07) está no prompt executado: entrevista enxuta, few-shot de persona, redireciona
 *    dados operacionais, distingue nome do assistente do nome do negócio e o aviso final.
 * 4. matchesGenerateIntent: casa intenção CLARA de gerar ("pode gerar", "gera a persona",
 *    "terminei") sem falso positivo com o verbo no meio da frase ("ele gere confiança", "manda
 *    bem com o cliente") nem com negação ("ainda não terminei").
 * 5. FEW-SHOT sem vazamento: os exemplos de persona da v4 não contêm dado operacional/mecânica.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  META_ENTREVISTADOR_PROMPT_V1,
  META_ENTREVISTADOR_PROMPT_V2,
  META_ENTREVISTADOR_PROMPT_V3,
  META_ENTREVISTADOR_PROMPT_V4,
  buildEntrevistadorSystemPrompt,
  matchesGenerateIntent,
  primeiraPergunta,
} from './meta-entrevistador.js';

function readMdBody(version: 'v1' | 'v2' | 'v3' | 'v4'): string {
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

  it('const V3 == corpo do v3.md (fonte canônica imutável)', () => {
    expect(META_ENTREVISTADOR_PROMPT_V3.trim()).toBe(readMdBody('v3'));
  });

  it('const V4 (runtime) == corpo do v4.md (fonte canônica)', () => {
    expect(META_ENTREVISTADOR_PROMPT_V4.trim()).toBe(readMdBody('v4'));
  });
});

describe('meta-entrevistador — v4 22/07 (V4 é o runtime)', () => {
  it('o system prompt executado mantém tom de consultor, gerar sob demanda, redirecionamento e aviso final', () => {
    const sp = buildEntrevistadorSystemPrompt({
      nomeNegocio: 'Barbearia do Zé',
      area: 'barbearia',
      modo: 'agenda',
    });
    // Tom profissional (sem gírias/emojis) + consultor de configuração.
    expect(sp).toContain('consultor de configuração');
    expect(sp).toContain('Sem gírias, sem emojis');
    // Entrevista enxuta (ordem do Bruno).
    expect(sp).toContain('OBJETIVIDADE ACIMA DE TUDO');
    expect(sp).toContain('Nada de paredão de texto');
    // GERAR SOB DEMANDA — o dono pode pedir pra gerar quando quiser.
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

  it('inclui few-shot de persona bem-feita (2 exemplos, referência de formato)', () => {
    const sp = buildEntrevistadorSystemPrompt({
      nomeNegocio: 'Barbearia do Zé',
      area: 'barbearia',
      modo: 'agenda',
    });
    expect(sp).toContain('EXEMPLOS DE PERSONA BEM-FEITA');
    expect(sp).toContain('Exemplo A (agenda):');
    expect(sp).toContain('Exemplo B (atendente):');
  });

  it('distingue nome do assistente (nome_do_bot, opcional) do nome do negócio (imutável)', () => {
    const sp = buildEntrevistadorSystemPrompt({
      nomeNegocio: 'Barbearia do Zé',
      area: 'barbearia',
      modo: 'agenda',
    });
    expect(sp).toContain('NOME DO ASSISTENTE vs NOME DO NEGÓCIO');
    expect(sp).toContain('nome_do_bot');
    // A persona nunca reescreve o nome do negócio.
    expect(sp).toMatch(/NUNCA reescreva/);
  });

  it('os exemplos few-shot NÃO vazam dado operacional nem mecânica (preço/horário/serviço/cartão/SIM/tool/dígito)', () => {
    // Extrai só as personas ENTRE ASPAS na seção de exemplos (a linha-guia cita os termos
    // proibidos de propósito e não deve ser escaneada).
    const secao = META_ENTREVISTADOR_PROMPT_V4.split('EXEMPLOS DE PERSONA BEM-FEITA')[1].split(
      'REGRAS DURAS',
    )[0];
    const personas = (secao.match(/"([^"]+)"/g) ?? []).join('\n');
    expect(personas.length).toBeGreaterThan(100); // achou os 2 exemplos
    const proibidos: RegExp[] = [
      /R\$/i,
      /\d/, // qualquer dígito (preço/horário)
      /pre[çc]o/i,
      /hor[áa]rio/i,
      /endere[çc]o/i,
      /telefone/i,
      /servi[çc]o/i,
      /cart[ãa]o/i,
      /_agendamento/,
      /\bSIM\b/, // marcador de confirmação
    ];
    for (const re of proibidos) {
      expect(re.test(personas), `few-shot vazou ${re}`).toBe(false);
    }
  });
});

describe('matchesGenerateIntent — intenção CLARA de gerar', () => {
  it('casa frases explícitas e comandos de fecho (mensagem inteira)', () => {
    for (const t of [
      // frases explícitas (qualquer posição)
      'pode gerar',
      'Pode gerar!',
      'pode gerar a persona agora',
      'gerar agora',
      'gera a persona',
      'gere isso',
      'pode montar',
      'acho que é isso, pode gerar',
      'pronto pode gerar',
      'é isso pode gerar',
      // comandos de fecho como mensagem inteira
      'gera',
      'gerar',
      'manda',
      'terminei',
      'pronto',
      'chega',
      'é isso',
      'só isso',
      'finaliza',
    ]) {
      expect(matchesGenerateIntent(t), t).toBe(true);
    }
  });

  it('NÃO casa o verbo no MEIO da frase (falso positivo antigo do v3)', () => {
    for (const t of [
      'quero que ele gere confiança',
      'a persona gera identificação',
      'quero que ele gera confiança no cliente',
      'manda bem com o cliente',
      'ele manda bem no atendimento',
    ]) {
      expect(matchesGenerateIntent(t), t).toBe(false);
    }
  });

  it('NÃO casa negação ("ainda não terminei", "não pode gerar")', () => {
    for (const t of [
      'ainda não terminei',
      'não pode gerar ainda',
      'não é isso',
      'ainda não é isso',
      'não, ainda quero ajustar',
    ]) {
      expect(matchesGenerateIntent(t), t).toBe(false);
    }
  });

  it('NÃO casa por substring nem em conversa normal', () => {
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

  it('string vazia / só pontuação -> false', () => {
    expect(matchesGenerateIntent('')).toBe(false);
    expect(matchesGenerateIntent('   ')).toBe(false);
    expect(matchesGenerateIntent('...')).toBe(false);
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
