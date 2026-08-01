/**
 * Testes PUROS do cartão injetável em RUNTIME (SCRUM-92 inc.2 / ADR 0032 §2.2):
 * mergeEmojis (override do dono vence, blank herda a área) + buildCartaoRuntimeBlock
 * (variantes agenda/estabelecimento/atendente, templates, emojis por área/override,
 * garantia da REGRA cartão+SIM invariante ao layout, determinismo).
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCO_ESTRUTURAL_MARKER,
  CARTAO_EMOJI_DISABLED,
  buildCartaoRuntimeBlock,
  mergeEmojis,
} from './bloco-estrutural.js';

/** Conta ocorrências não-sobrepostas de `needle` em `hay`. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

// Base estruturalmente compatível com CartaoEmojis (interface interna) = barbearia de hoje.
const BASE = {
  marca: '💈',
  dia: '📅',
  horario: '⏰',
  servico: '✂️',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};

describe('mergeEmojis', () => {
  it('sem override devolve a base intacta', () => {
    expect(mergeEmojis(BASE, undefined)).toEqual(BASE);
    expect(mergeEmojis(BASE, null)).toEqual(BASE);
  });

  it('override do dono VENCE só nas chaves informadas (resto herda a área)', () => {
    const out = mergeEmojis(BASE, { marca: '🌻', servico: '🎨' });
    expect(out.marca).toBe('🌻');
    expect(out.servico).toBe('🎨');
    expect(out.dia).toBe('📅'); // não informado → herda
    expect(out.confirma).toBe('✅');
  });

  it('valor vazio/branco NÃO apaga o ícone (herda a base — defensivo)', () => {
    expect(mergeEmojis(BASE, { marca: '' }).marca).toBe('💈');
    expect(mergeEmojis(BASE, { marca: '   ' }).marca).toBe('💈');
  });

  it('SENTINELA CARTAO_EMOJI_DISABLED apaga o ícone (emoji vazio) — só ele, não string em branco', () => {
    const out = mergeEmojis(BASE, { marca: CARTAO_EMOJI_DISABLED });
    expect(out.marca).toBe('');
    // as outras chaves seguem herdando a base normalmente.
    expect(out.servico).toBe('✂️');
  });

  it('sentinela funciona em qualquer chave, inclusive confirma/profissional', () => {
    const out = mergeEmojis(BASE, {
      confirma: CARTAO_EMOJI_DISABLED,
      profissional: CARTAO_EMOJI_DISABLED,
    });
    expect(out.confirma).toBe('');
    expect(out.profissional).toBe('');
    expect(out.marca).toBe('💈'); // não tocado → herda
  });
});

describe('buildCartaoRuntimeBlock — variante agenda', () => {
  it('barbearia usa os emojis da área e carrega a REGRA (cartão + SIM antes de inserir_agendamento)', () => {
    const bloco = buildCartaoRuntimeBlock({ modo: 'agenda', area: 'barbearia' });
    expect(bloco).toContain('💈');
    expect(bloco).toContain('✂️');
    expect(bloco).toContain('inserir_agendamento');
    expect(bloco).toMatch(/SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento/);
    // 1 cartão só: 1 header estrutural + 1 abertura de cartão.
    expect(count(bloco, BLOCO_ESTRUTURAL_MARKER)).toBe(1);
    expect(count(bloco, '[CARTAO DE CONFIRMACAO')).toBe(1);
    // Individual NÃO tem campo de profissional.
    expect(bloco).not.toContain('PROFISSIONAL');
  });

  it('área não-barbearia troca a marca (salão → 💇), sem 💈', () => {
    const bloco = buildCartaoRuntimeBlock({ modo: 'agenda', area: 'salao' });
    expect(bloco).toContain('💇');
    expect(bloco).not.toContain('💈');
  });

  it('override do dono (cartao_config.emojis) VENCE a área — 🌻 no lugar do 💈', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'barbearia',
      config: { emojis: { marca: '🌻' } },
    });
    expect(bloco).toContain('🌻');
    expect(bloco).not.toContain('💈');
  });

  it('nomeNegocio concreto entra no cartão; ausente cai no placeholder', () => {
    const comNome = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'barbearia',
      nomeNegocio: 'Barbearia do Zé',
    });
    expect(comNome).toContain('💈 Barbearia do Zé');
    expect(comNome).not.toContain('<nome do negócio>');

    const semNome = buildCartaoRuntimeBlock({ modo: 'agenda', area: 'barbearia' });
    expect(semNome).toContain('<nome do negócio>');
  });

  it('template muda só o LAYOUT, NUNCA a REGRA (cartão + SIM permanece)', () => {
    for (const template of ['padrao', 'compacto', 'detalhado'] as const) {
      const bloco = buildCartaoRuntimeBlock({
        modo: 'agenda',
        area: 'barbearia',
        config: { template },
      });
      expect(bloco).toContain(BLOCO_ESTRUTURAL_MARKER);
      expect(bloco).toMatch(/SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento/);
      expect(count(bloco, '[CARTAO DE CONFIRMACAO')).toBe(1);
    }
    const compacto = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'barbearia',
      config: { template: 'compacto' },
    });
    const padrao = buildCartaoRuntimeBlock({ modo: 'agenda', area: 'barbearia' });
    // Layout diferente do padrão (o compacto usa a linha única).
    expect(compacto).not.toBe(padrao);
    expect(compacto).toContain('uma linha só');
  });
});

describe('buildCartaoRuntimeBlock — variante estabelecimento', () => {
  it('inclui 👤 PROFISSIONAL uma única vez, usa 🕐 (não ⏰) e mantém a REGRA', () => {
    const bloco = buildCartaoRuntimeBlock({ modo: 'estabelecimento', area: 'barbearia' });
    expect(bloco).toContain('👤 PROFISSIONAL:');
    expect(count(bloco, '👤 PROFISSIONAL:')).toBe(1);
    expect(bloco).toContain('🕐');
    expect(bloco).not.toMatch(/⏰ HORARIO/);
    expect(bloco).toMatch(/SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento/);
    expect(count(bloco, '[CARTAO DE CONFIRMACAO')).toBe(1);
  });

  it('área não-barbearia troca o serviço (manicure → 💅) e mantém 👤', () => {
    const bloco = buildCartaoRuntimeBlock({ modo: 'estabelecimento', area: 'manicure' });
    expect(bloco).toContain('💅');
    expect(bloco).toContain('👤 PROFISSIONAL:');
  });
});

describe('buildCartaoRuntimeBlock — caminho VERBATIM (clone migrado)', () => {
  const CARTAO_LEGADO = [
    '[CARTAO DE CONFIRMACAO]',
    '💈 Barbearia do Zé',
    '📅 DIA: <dia> / ⏰ HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
    'Responda SIM para confirmar. ✅',
  ].join('\n');

  it('config.verbatim EMITE o cartão legado LITERALMENTE (ignora template/emojis/área)', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'salao', // seria 💇 no montado — mas o verbatim vence
      config: { verbatim: CARTAO_LEGADO, template: 'detalhado', emojis: { marca: '🌻' } },
      nomeNegocio: 'Outro Nome',
    });
    expect(bloco).toBe(CARTAO_LEGADO);
    expect(bloco).not.toContain('🌻');
    expect(bloco).not.toContain('💇');
    expect(bloco).not.toContain('Outro Nome');
  });

  it('verbatim vazio/branco NÃO ativa o caminho legado (cai no montado)', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'barbearia',
      config: { verbatim: '   ' },
    });
    expect(bloco).toContain(BLOCO_ESTRUTURAL_MARKER);
  });

  it('atendente com verbatim segue vazio (pré-venda nunca tem cartão)', () => {
    expect(
      buildCartaoRuntimeBlock({ modo: 'atendente', config: { verbatim: CARTAO_LEGADO } }),
    ).toBe('');
  });
});

describe('buildCartaoRuntimeBlock — atendente + determinismo', () => {
  it('atendente NÃO tem cartão (string vazia) em qualquer template', () => {
    expect(buildCartaoRuntimeBlock({ modo: 'atendente' })).toBe('');
    expect(buildCartaoRuntimeBlock({ modo: 'atendente', config: { template: 'detalhado' } })).toBe(
      '',
    );
  });

  it('é puro/determinístico: mesma entrada → mesma string', () => {
    const opts = {
      modo: 'agenda' as const,
      area: 'estetica',
      config: { template: 'detalhado' as const, emojis: { marca: '🌟' } },
      nomeNegocio: 'Studio X',
    };
    expect(buildCartaoRuntimeBlock(opts)).toBe(buildCartaoRuntimeBlock(opts));
  });
});

/**
 * Emoji DESABILITADO (CARTAO_EMOJI_DISABLED) — decisão do Bruno: desabilitar tira SÓ o ícone,
 * a linha FICA. `💈 Barbearia X` vira `Barbearia X`, NUNCA ` Barbearia X` (espaço à esquerda).
 * Cobre os 3 templates × agenda/estabelecimento (regra 27/28: byte-a-byte quando não muda nada,
 * e área NÃO-barbearia — Ingrid é `area='outro'` — é o caminho desprotegido do
 * buildCartaoEmojiOverrideBlock legado; aqui cobrimos com area='outro' e area=null/dragon).
 */
describe('buildCartaoRuntimeBlock — emoji DESABILITADO (sentinela) não deixa espaço órfão', () => {
  it('agenda/padrao: marca desabilitada → linha some o ícone, sem espaço à esquerda (area="outro", caso Ingrid)', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'outro',
      config: { emojis: { marca: CARTAO_EMOJI_DISABLED } },
      nomeNegocio: 'Consultório da Ingrid',
    });
    expect(bloco).toContain('\nConsultório da Ingrid\n');
    expect(bloco).not.toContain(' Consultório da Ingrid');
    expect(bloco).not.toContain('  Consultório'); // dois espaços = sinal de campo vazio no meio
  });

  it('agenda/padrao: dia desabilitado no meio da linha combinada não deixa "//" nem espaço duplo (area=null, caso dragon)', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: null,
      config: { emojis: { dia: CARTAO_EMOJI_DISABLED } },
    });
    // "DIA: <dia> / HORARIO: <horario> / ..." sem o emoji de dia, mas com separador ' / ' intacto.
    expect(bloco).toContain('DIA: <dia> / ⏰ HORARIO: <horario>');
    expect(bloco).not.toContain('  DIA'); // não sobrou espaço duplo onde o emoji estava
  });

  it('agenda/compacto: TODOS os emojis desabilitados → linha vira só texto com separadores intactos', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'barbearia',
      config: {
        template: 'compacto',
        emojis: {
          marca: CARTAO_EMOJI_DISABLED,
          dia: CARTAO_EMOJI_DISABLED,
          horario: CARTAO_EMOJI_DISABLED,
          servico: CARTAO_EMOJI_DISABLED,
          valor: CARTAO_EMOJI_DISABLED,
        },
      },
      nomeNegocio: 'Barbearia X',
    });
    expect(bloco).toContain('Barbearia X — <dia> <horario> <servico> <valor>');
    expect(bloco).not.toMatch(/ {2,}/); // nunca 2+ espaços seguidos
  });

  it('agenda/detalhado: valor desabilitado → linha vira só "VALOR: <valor>" sem espaço à esquerda', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'barbearia',
      config: { template: 'detalhado', emojis: { valor: CARTAO_EMOJI_DISABLED } },
      nomeNegocio: 'Barbearia X',
    });
    expect(bloco).toContain('\nVALOR: <valor>\n');
    expect(bloco).not.toContain(' VALOR: <valor>');
  });

  it('estabelecimento/padrao: profissional desabilitado → linha vira só "PROFISSIONAL: <...>"', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'estabelecimento',
      area: 'barbearia',
      config: { emojis: { profissional: CARTAO_EMOJI_DISABLED } },
    });
    expect(bloco).toContain('\nPROFISSIONAL: <nome do profissional escolhido>\n');
    expect(bloco).not.toContain(' PROFISSIONAL:');
  });

  it('estabelecimento/compacto: horario (🕐) desabilitado não deixa espaço duplo', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'estabelecimento',
      area: 'barbearia',
      config: { template: 'compacto', emojis: { horario: CARTAO_EMOJI_DISABLED } },
    });
    expect(bloco).not.toMatch(/ {2,}/);
  });

  it('estabelecimento/detalhado: confirma desabilitado → fechamento sem espaço à direita', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'estabelecimento',
      area: 'barbearia',
      config: { template: 'detalhado', emojis: { confirma: CARTAO_EMOJI_DISABLED } },
    });
    expect(bloco).toContain('Termine o cartão pedindo: "Responda SIM para confirmar."\n');
    expect(bloco).not.toContain('confirmar." \n');
    expect(bloco).not.toMatch(/confirmar\."\s+$/m);
  });

  it('confirma desabilitado no fechamento (compacto) não deixa trailing space', () => {
    const bloco = buildCartaoRuntimeBlock({
      modo: 'agenda',
      area: 'barbearia',
      config: { template: 'compacto', emojis: { confirma: CARTAO_EMOJI_DISABLED } },
    });
    const linhaFechamento = bloco.split('\n').find((l) => l.includes('Depois peça'));
    expect(linhaFechamento).toBe('Depois peça: "Responda SIM para confirmar."');
  });
});
