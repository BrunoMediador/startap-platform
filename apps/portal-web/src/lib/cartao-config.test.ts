import { describe, expect, it } from 'vitest';
import {
  CARTAO_SLOTS,
  type CartaoDraft,
  type CartaoEmojis,
  FALLBACK_EMOJIS,
  FALLBACK_TEMPLATE,
  PREVIEW_SAMPLE,
  buildCartaoPreview,
  isCartaoDirty,
  isCartaoVisible,
  isEmojiAllowed,
  normalizeCartaoResponse,
  normalizeTemplate,
  parsePreview,
  previewLines,
  sanitizeEmojis,
  setEmoji,
  setTemplate,
  toCartaoDraft,
  toCartaoPayload,
} from './cartao-config';

// Config runtime completa e válida (todos os emojis do catálogo).
function runtimeRaw(over?: Record<string, unknown>) {
  return {
    mode: 'runtime',
    config: {
      template: 'compacto',
      emojis: {
        marca: '✂️',
        dia: '🗓️',
        horario: '🕐',
        servico: '💇',
        valor: '💵',
        confirma: '👍',
        profissional: '🧑‍🔧',
      },
    },
    defaults: { template: 'padrao', emojis: FALLBACK_EMOJIS },
    canDisable: false,
    ...over,
  };
}

describe('normalizeTemplate', () => {
  it('aceita os 3 templates válidos', () => {
    expect(normalizeTemplate('padrao')).toBe('padrao');
    expect(normalizeTemplate('compacto')).toBe('compacto');
    expect(normalizeTemplate('detalhado')).toBe('detalhado');
  });
  it('rejeita valor desconhecido / não-string', () => {
    expect(normalizeTemplate('xyz')).toBeNull();
    expect(normalizeTemplate(null)).toBeNull();
    expect(normalizeTemplate(42)).toBeNull();
    expect(normalizeTemplate(undefined)).toBeNull();
  });
});

describe('isEmojiAllowed (allowlist do picker)', () => {
  it('aceita só o que está no catálogo daquele slot', () => {
    expect(isEmojiAllowed('marca', '💈')).toBe(true);
    expect(isEmojiAllowed('confirma', '✅')).toBe(true);
    // emoji válido, mas de OUTRO slot -> negado (allowlist por-slot)
    expect(isEmojiAllowed('confirma', '💈')).toBe(false);
    // emoji arbitrário fora de qualquer catálogo -> negado (anti-injeção)
    expect(isEmojiAllowed('marca', '🔥')).toBe(false);
    expect(isEmojiAllowed('marca', 'não-emoji')).toBe(false);
  });
});

describe('sanitizeEmojis', () => {
  it('mantém emojis válidos e cai no fallback nos slots ausentes/ inválidos', () => {
    const out = sanitizeEmojis({ marca: '✂️', dia: '🔥', valor: 'texto' }, FALLBACK_EMOJIS);
    expect(out.marca).toBe('✂️'); // válido
    expect(out.dia).toBe(FALLBACK_EMOJIS.dia); // fora do catálogo -> fallback
    expect(out.valor).toBe(FALLBACK_EMOJIS.valor); // não-emoji -> fallback
    expect(out.confirma).toBe(FALLBACK_EMOJIS.confirma); // ausente -> fallback
  });
  it('cru não-objeto -> tudo fallback', () => {
    expect(sanitizeEmojis(null, FALLBACK_EMOJIS)).toEqual(FALLBACK_EMOJIS);
    expect(sanitizeEmojis('nope', FALLBACK_EMOJIS)).toEqual(FALLBACK_EMOJIS);
  });
  it('sempre devolve os 7 slots preenchidos', () => {
    const out = sanitizeEmojis({}, FALLBACK_EMOJIS);
    for (const slot of CARTAO_SLOTS) expect(typeof out[slot]).toBe('string');
  });
});

describe('normalizeCartaoResponse — DORMÊNCIA', () => {
  it('mode !== runtime -> indisponivel (esconde)', () => {
    expect(normalizeCartaoResponse({ mode: 'baked', config: null })).toEqual({
      status: 'indisponivel',
    });
  });
  it('mode ausente / resposta inválida -> indisponivel', () => {
    expect(normalizeCartaoResponse(null)).toEqual({ status: 'indisponivel' });
    expect(normalizeCartaoResponse('boom')).toEqual({ status: 'indisponivel' });
    expect(normalizeCartaoResponse({})).toEqual({ status: 'indisponivel' });
  });
  it('runtime com config -> estado com a config efetiva', () => {
    const st = normalizeCartaoResponse(runtimeRaw());
    expect(st.status).toBe('runtime');
    if (st.status !== 'runtime') throw new Error('esperado runtime');
    expect(st.template).toBe('compacto');
    expect(st.emojis.dia).toBe('🗓️');
    expect(st.defaults.template).toBe('padrao');
    expect(st.canDisable).toBe(false);
  });
  it('runtime com config:null -> cai nos defaults', () => {
    const st = normalizeCartaoResponse(runtimeRaw({ config: null }));
    if (st.status !== 'runtime') throw new Error('esperado runtime');
    expect(st.template).toBe(st.defaults.template);
    expect(st.emojis).toEqual(st.defaults.emojis);
  });
  it('config parcial -> merge sobre defaults (slot não-tocado = default)', () => {
    const st = normalizeCartaoResponse(
      runtimeRaw({ config: { template: 'detalhado', emojis: { marca: '💅' } } }),
    );
    if (st.status !== 'runtime') throw new Error('esperado runtime');
    expect(st.template).toBe('detalhado');
    expect(st.emojis.marca).toBe('💅'); // override
    expect(st.emojis.dia).toBe(st.defaults.emojis.dia); // herdado do default
  });
  it('defaults ausentes -> usa o fallback do catálogo', () => {
    const st = normalizeCartaoResponse({ mode: 'runtime', config: null });
    if (st.status !== 'runtime') throw new Error('esperado runtime');
    expect(st.defaults.template).toBe(FALLBACK_TEMPLATE);
    expect(st.defaults.emojis).toEqual(FALLBACK_EMOJIS);
  });
});

describe('isCartaoVisible', () => {
  it('só é visível quando runtime', () => {
    expect(isCartaoVisible({ status: 'indisponivel' })).toBe(false);
    expect(isCartaoVisible(undefined)).toBe(false);
    const st = normalizeCartaoResponse(runtimeRaw());
    expect(isCartaoVisible(st)).toBe(true);
  });
});

describe('parsePreview', () => {
  it('extrai string não-vazia', () => {
    expect(parsePreview({ preview: 'oi' })).toBe('oi');
  });
  it('ignora ausente / vazio / não-string', () => {
    expect(parsePreview({})).toBeNull();
    expect(parsePreview({ preview: '' })).toBeNull();
    expect(parsePreview({ preview: 3 })).toBeNull();
    expect(parsePreview(null)).toBeNull();
  });
});

describe('rascunho: setTemplate / setEmoji (picker fechado)', () => {
  const base: CartaoDraft = { template: 'padrao', emojis: { ...FALLBACK_EMOJIS } };

  it('setTemplate troca imutavelmente', () => {
    const next = setTemplate(base, 'compacto');
    expect(next.template).toBe('compacto');
    expect(base.template).toBe('padrao'); // não mutou o original
  });
  it('setEmoji aceita emoji do catálogo do slot', () => {
    const next = setEmoji(base, 'marca', '✂️');
    expect(next.emojis.marca).toBe('✂️');
    expect(base.emojis.marca).toBe('💈'); // imutável
  });
  it('setEmoji IGNORA emoji fora do catálogo (2ª trava anti-injeção)', () => {
    const next = setEmoji(base, 'marca', '🔥');
    expect(next).toBe(base); // rascunho intacto
  });
  it('setEmoji não deixa vazar emoji de outro slot', () => {
    const next = setEmoji(base, 'confirma', '💈');
    expect(next).toBe(base);
  });
});

describe('isCartaoDirty', () => {
  const a: CartaoDraft = { template: 'padrao', emojis: { ...FALLBACK_EMOJIS } };
  it('igual = não-dirty', () => {
    expect(isCartaoDirty(a, { template: 'padrao', emojis: { ...FALLBACK_EMOJIS } })).toBe(false);
  });
  it('template diferente = dirty', () => {
    expect(isCartaoDirty(a, { ...a, template: 'compacto' })).toBe(true);
  });
  it('um emoji diferente = dirty', () => {
    const b = setEmoji(a, 'marca', '✂️');
    expect(isCartaoDirty(a, b)).toBe(true);
  });
});

describe('toCartaoPayload / toCartaoDraft (sem vazar referência)', () => {
  it('payload copia os emojis', () => {
    const d: CartaoDraft = { template: 'padrao', emojis: { ...FALLBACK_EMOJIS } };
    const p = toCartaoPayload(d);
    p.emojis.marca = '✂️';
    expect(d.emojis.marca).toBe('💈');
  });
  it('draft do estado copia os emojis', () => {
    const st = normalizeCartaoResponse(runtimeRaw());
    if (st.status !== 'runtime') throw new Error('esperado runtime');
    const d = toCartaoDraft(st);
    d.emojis.marca = '💅';
    expect(st.emojis.marca).toBe('✂️');
  });
});

describe('buildCartaoPreview — montagem do cartão a partir da config', () => {
  const emojis: CartaoEmojis = { ...FALLBACK_EMOJIS };

  it('padrao: uma linha por informação, com o valor da amostra e o nome em negrito', () => {
    const out = buildCartaoPreview('padrao', emojis);
    expect(out).toContain(`💈 *${PREVIEW_SAMPLE.marca}*`);
    expect(out).toContain(`📅 Dia: ${PREVIEW_SAMPLE.dia}`);
    expect(out).toContain(`✅ ${PREVIEW_SAMPLE.confirma}`);
    // 7 linhas de conteúdo (marca + 5 campos + confirma)
    expect(previewLines(out)).toHaveLength(7);
  });

  it('compacto: menos linhas que o padrão', () => {
    const compacto = previewLines(buildCartaoPreview('compacto', emojis)).length;
    const padrao = previewLines(buildCartaoPreview('padrao', emojis)).length;
    expect(compacto).toBeLessThan(padrao);
  });

  it('detalhado: inclui a frase de abertura', () => {
    const out = buildCartaoPreview('detalhado', emojis);
    expect(out).toContain('Vamos confirmar seu agendamento:');
  });

  it('reflete o emoji escolhido no slot certo', () => {
    const custom = setEmoji({ template: 'padrao', emojis }, 'confirma', '👍');
    const out = buildCartaoPreview(custom.template, custom.emojis);
    expect(out).toContain(`👍 ${PREVIEW_SAMPLE.confirma}`);
    expect(out).not.toContain('✅');
  });

  it('aceita amostra customizada', () => {
    const out = buildCartaoPreview('padrao', emojis, { ...PREVIEW_SAMPLE, servico: 'Barba' });
    expect(out).toContain('Serviço: Barba');
  });
});
