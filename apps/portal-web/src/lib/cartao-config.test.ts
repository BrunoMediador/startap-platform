import { describe, expect, it } from 'vitest';
import {
  CARTAO_SLOTS,
  type CartaoDraft,
  type CartaoEmojis,
  FALLBACK_EMOJIS,
  PREVIEW_SAMPLE,
  buildCartaoPreview,
  isCartaoDirty,
  isCartaoEditable,
  isCartaoLocked,
  isEmojiAllowed,
  normalizeCartaoResponse,
  normalizeLockedReason,
  normalizeTemplate,
  parsePreview,
  previewLines,
  sanitizeEmojis,
  setEmoji,
  setTemplate,
  toCartaoDraft,
  toCartaoPayload,
} from './cartao-config';

// GET editável completo (o cartão ATUAL do cliente vem em `config`).
function editableRaw(over?: Record<string, unknown>) {
  return {
    mode: 'runtime',
    editable: true,
    locked_reason: null,
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
    preview: '===== REGRAS DO SISTEMA =====\n[CARTAO ...]', // bloco interno; nunca exibido
    ...over,
  };
}

// GET travado (read-only) — só defaults; config sempre null.
function lockedRaw(reason: 'prompt_custom' | 'requer_revisao', over?: Record<string, unknown>) {
  return {
    mode: 'baked',
    editable: false,
    locked_reason: reason,
    config: null,
    defaults: { template: 'padrao', emojis: FALLBACK_EMOJIS },
    canDisable: false,
    preview: '===== REGRAS DO SISTEMA =====',
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

describe('normalizeLockedReason', () => {
  it('aceita só os 2 motivos conhecidos', () => {
    expect(normalizeLockedReason('prompt_custom')).toBe('prompt_custom');
    expect(normalizeLockedReason('requer_revisao')).toBe('requer_revisao');
    expect(normalizeLockedReason(null)).toBeNull();
    expect(normalizeLockedReason('outro')).toBeNull();
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

// ── Mapeamento dos 4 estados (a função pura: dado o GET -> o que renderiza) ──────────

describe('normalizeCartaoResponse — 4 estados', () => {
  it('ESTADO 1 (editable): seed do picker vem de `config`', () => {
    const st = normalizeCartaoResponse(editableRaw());
    expect(st.status).toBe('editable');
    if (st.status !== 'editable') throw new Error('esperado editable');
    expect(st.template).toBe('compacto'); // config.template
    expect(st.emojis.dia).toBe('🗓️'); // config.emojis (o cartão ATUAL do cliente)
    expect(st.emojis.confirma).toBe('👍');
    expect(st.defaults.template).toBe('padrao');
  });

  it('ESTADO 1 (editable) com config:null -> seed cai nos defaults', () => {
    const st = normalizeCartaoResponse(editableRaw({ config: null }));
    if (st.status !== 'editable') throw new Error('esperado editable');
    expect(st.template).toBe(st.defaults.template);
    expect(st.emojis).toEqual(st.defaults.emojis);
  });

  it('ESTADO 1 (editable) com config parcial -> merge sobre defaults', () => {
    const st = normalizeCartaoResponse(
      editableRaw({ config: { template: 'detalhado', emojis: { marca: '💅' } } }),
    );
    if (st.status !== 'editable') throw new Error('esperado editable');
    expect(st.template).toBe('detalhado');
    expect(st.emojis.marca).toBe('💅'); // override do cliente
    expect(st.emojis.dia).toBe(st.defaults.emojis.dia); // herda o default
  });

  it('ESTADO 2 (locked: prompt_custom) -> read-only, sem picker', () => {
    const st = normalizeCartaoResponse(lockedRaw('prompt_custom'));
    expect(st.status).toBe('locked');
    if (st.status !== 'locked') throw new Error('esperado locked');
    expect(st.reason).toBe('prompt_custom');
    // carrega defaults só pra prévia ilustrativa
    expect(st.template).toBe('padrao');
    expect(st.emojis).toEqual(FALLBACK_EMOJIS);
  });

  it('ESTADO 3 (locked: requer_revisao) -> read-only', () => {
    const st = normalizeCartaoResponse(lockedRaw('requer_revisao'));
    if (st.status !== 'locked') throw new Error('esperado locked');
    expect(st.reason).toBe('requer_revisao');
  });

  it('ESTADO 4 (hidden): resposta inválida / vazia some', () => {
    expect(normalizeCartaoResponse(null)).toEqual({ status: 'hidden' });
    expect(normalizeCartaoResponse('boom')).toEqual({ status: 'hidden' });
    expect(normalizeCartaoResponse({})).toEqual({ status: 'hidden' });
  });

  it('ESTADO 4 (hidden): editable:false SEM motivo conhecido some (defensivo)', () => {
    expect(normalizeCartaoResponse({ editable: false, locked_reason: null })).toEqual({
      status: 'hidden',
    });
    expect(normalizeCartaoResponse({ editable: false, locked_reason: 'xpto' })).toEqual({
      status: 'hidden',
    });
  });

  it('editable ganha de um locked_reason contraditório (contrato: exclusivos)', () => {
    const st = normalizeCartaoResponse(editableRaw({ locked_reason: 'prompt_custom' }));
    expect(st.status).toBe('editable');
  });
});

describe('type guards isCartaoEditable / isCartaoLocked', () => {
  it('discriminam os estados', () => {
    const ed = normalizeCartaoResponse(editableRaw());
    const lk = normalizeCartaoResponse(lockedRaw('prompt_custom'));
    expect(isCartaoEditable(ed)).toBe(true);
    expect(isCartaoLocked(ed)).toBe(false);
    expect(isCartaoLocked(lk)).toBe(true);
    expect(isCartaoEditable(lk)).toBe(false);
    expect(isCartaoEditable(undefined)).toBe(false);
    expect(isCartaoLocked({ status: 'hidden' })).toBe(false);
  });
});

describe('parsePreview (sinal cru — nunca renderizado)', () => {
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
  it('igual = não-dirty (cliente que não mexeu -> PUT mantém idêntico)', () => {
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

describe('seed do picker -> rascunho (sem vazar referência)', () => {
  it('toCartaoDraft copia os emojis do estado editável', () => {
    const st = normalizeCartaoResponse(editableRaw());
    if (st.status !== 'editable') throw new Error('esperado editable');
    const d = toCartaoDraft(st);
    // o rascunho nasce IGUAL ao cartão atual do cliente (seed)
    expect(d.template).toBe('compacto');
    expect(d.emojis.dia).toBe('🗓️');
    d.emojis.marca = '💅';
    expect(st.emojis.marca).toBe('✂️'); // não vazou a ref
  });
  it('toCartaoPayload copia os emojis', () => {
    const d: CartaoDraft = { template: 'padrao', emojis: { ...FALLBACK_EMOJIS } };
    const p = toCartaoPayload(d);
    p.emojis.marca = '✂️';
    expect(d.emojis.marca).toBe('💈');
  });
});

describe('buildCartaoPreview — prévia amigável (não o bloco interno do servidor)', () => {
  const emojis: CartaoEmojis = { ...FALLBACK_EMOJIS };

  it('padrao: uma linha por informação, com a amostra e o nome em negrito', () => {
    const out = buildCartaoPreview('padrao', emojis);
    expect(out).toContain(`💈 *${PREVIEW_SAMPLE.marca}*`);
    expect(out).toContain(`📅 Dia: ${PREVIEW_SAMPLE.dia}`);
    expect(out).toContain(`✅ ${PREVIEW_SAMPLE.confirma}`);
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

  it('NÃO é o bloco interno do runtime (sem "REGRAS DO SISTEMA")', () => {
    const st = normalizeCartaoResponse(editableRaw());
    if (st.status !== 'editable') throw new Error('esperado editable');
    const out = buildCartaoPreview(st.template, st.emojis);
    expect(out).not.toContain('REGRAS DO SISTEMA');
    expect(out).not.toContain('REGRA CRITICA');
  });

  it('aceita amostra customizada', () => {
    const out = buildCartaoPreview('padrao', emojis, { ...PREVIEW_SAMPLE, servico: 'Barba' });
    expect(out).toContain('Serviço: Barba');
  });
});
