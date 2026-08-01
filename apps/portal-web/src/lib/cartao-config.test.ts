import { describe, expect, it } from 'vitest';
import {
  CARTAO_EMOJI_DISABLED,
  CARTAO_SLOTS,
  type CartaoDraft,
  type CartaoEmojis,
  FALLBACK_EMOJIS,
  PREVIEW_SAMPLE,
  buildCartaoPreview,
  disableEmoji,
  isCartaoDirty,
  isCartaoEditable,
  isCartaoLocked,
  isEmojiAllowed,
  isEmojiDisabled,
  isSingleValidEmoji,
  normalizeCartaoResponse,
  normalizeLockedReason,
  normalizePreviews,
  normalizeTemplate,
  parsePreview,
  partirNegrito,
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
  it('aceita QUALQUER emoji único válido, em qualquer slot (emoji livre)', () => {
    expect(isEmojiAllowed('marca', '💈')).toBe(true);
    expect(isEmojiAllowed('confirma', '✅')).toBe(true);
    // O catálogo fechado MORREU (decisão do Bruno 31/07): emoji do teclado do aparelho.
    // Emoji de "outro slot" e emoji fora de qualquer catálogo agora PASSAM.
    expect(isEmojiAllowed('confirma', '💈')).toBe(true);
    expect(isEmojiAllowed('marca', '🔥')).toBe(true);
    // ...e o sentinela de desabilitado também é um valor aceitável.
    expect(isEmojiAllowed('marca', CARTAO_EMOJI_DISABLED)).toBe(true);
  });

  it('continua negando o que NÃO é um emoji único (a trava que importa)', () => {
    expect(isEmojiAllowed('marca', 'não-emoji')).toBe(false);
    expect(isEmojiAllowed('marca', 'a')).toBe(false);
    expect(isEmojiAllowed('marca', '')).toBe(false);
    expect(isEmojiAllowed('marca', ' ')).toBe(false);
    expect(isEmojiAllowed('marca', '💈💈')).toBe(false); // 2 emojis
    expect(isEmojiAllowed('marca', '💈a')).toBe(false); // emoji + texto
  });
});

describe('isSingleValidEmoji — paridade com o backend (anti prompt-injection)', () => {
  it('aceita emoji simples, variation selector, ZWJ legítimo e keycap', () => {
    expect(isSingleValidEmoji('💈')).toBe(true);
    expect(isSingleValidEmoji('✂️')).toBe(true); // VS16
    expect(isSingleValidEmoji('👨‍👩‍👧')).toBe(true); // ZWJ
    expect(isSingleValidEmoji('1️⃣')).toBe(true); // keycap
    expect(isSingleValidEmoji('🇧🇷')).toBe(true); // bandeira
  });

  it('rejeita bytes invisíveis coláveis no system prompt do bot', () => {
    // Tag chars (U+E0000-E007F): o vetor canônico de smuggling em prompt de LLM.
    expect(isSingleValidEmoji('💈\u{E0041}\u{E007F}')).toBe(false);
    // Bandeira de subdivisão é RGI válida mas USA tag chars — rejeitada de propósito.
    expect(
      isSingleValidEmoji('\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'),
    ).toBe(false);
    expect(isSingleValidEmoji('💈​')).toBe(false); // ZWSP
    expect(isSingleValidEmoji('💈﻿')).toBe(false); // BOM
    expect(isSingleValidEmoji('💈‮')).toBe(false); // RLO (bidi override)
    expect(isSingleValidEmoji('💈\n')).toBe(false); // newline
    expect(isSingleValidEmoji('‍')).toBe(false); // ZWJ órfão
  });

  it('rejeita não-emoji', () => {
    expect(isSingleValidEmoji('a')).toBe(false);
    expect(isSingleValidEmoji('7')).toBe(false);
    expect(isSingleValidEmoji('.')).toBe(false);
    expect(isSingleValidEmoji('')).toBe(false);
    expect(isSingleValidEmoji(null)).toBe(false);
    expect(isSingleValidEmoji(CARTAO_EMOJI_DISABLED)).toBe(false); // sentinela não é emoji
  });
});

describe('sanitizeEmojis', () => {
  it('mantém emoji livre válido e cai no fallback no que não é emoji', () => {
    const out = sanitizeEmojis({ marca: '✂️', dia: '🔥', valor: 'texto' }, FALLBACK_EMOJIS);
    expect(out.marca).toBe('✂️'); // válido
    expect(out.dia).toBe('🔥'); // emoji LIVRE agora passa (não há mais catálogo)
    expect(out.valor).toBe(FALLBACK_EMOJIS.valor); // não-emoji -> fallback
    expect(out.confirma).toBe(FALLBACK_EMOJIS.confirma); // ausente -> fallback
  });

  it('preserva o sentinela de desabilitado (não é "inválido")', () => {
    const out = sanitizeEmojis({ marca: CARTAO_EMOJI_DISABLED }, FALLBACK_EMOJIS);
    expect(out.marca).toBe(CARTAO_EMOJI_DISABLED);
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
  it('setEmoji ACEITA emoji livre (o catálogo fechado saiu)', () => {
    const next = setEmoji(base, 'marca', '🔥');
    expect(next.emojis.marca).toBe('🔥');
    expect(next).not.toBe(base);
  });
  it('setEmoji aceita emoji de qualquer slot em qualquer slot', () => {
    const next = setEmoji(base, 'confirma', '💈');
    expect(next.emojis.confirma).toBe('💈');
  });
  it('setEmoji IGNORA o que não é emoji único (2ª trava anti-injeção)', () => {
    expect(setEmoji(base, 'marca', 'texto')).toBe(base); // rascunho intacto
    expect(setEmoji(base, 'marca', '💈💈')).toBe(base);
    expect(setEmoji(base, 'marca', '💈\u{E0041}')).toBe(base); // tag char
    expect(setEmoji(base, 'marca', '')).toBe(base);
  });

  it('disableEmoji grava o sentinela e isEmojiDisabled o reconhece', () => {
    const next = disableEmoji(base, 'marca');
    expect(next.emojis.marca).toBe(CARTAO_EMOJI_DISABLED);
    expect(isEmojiDisabled(next.emojis, 'marca')).toBe(true);
    expect(isEmojiDisabled(next.emojis, 'dia')).toBe(false);
    // reversível: reabilitar é só setEmoji de novo
    const volta = setEmoji(next, 'marca', '💈');
    expect(isEmojiDisabled(volta.emojis, 'marca')).toBe(false);
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

describe('normalizePreviews (prévia FIEL do backend — SCRUM-99)', () => {
  const good = {
    padrao: '💈 Zé\n📅 DIA: ...',
    compacto: '💈 Zé — ...',
    detalhado: '💈 Zé\n📅 DIA: ...',
  };

  it('aceita as 3 strings não-vazias', () => {
    expect(normalizePreviews(good)).toEqual(good);
  });

  it('descarta objeto incompleto / não-string / vazio → null (fallback)', () => {
    expect(normalizePreviews({ padrao: 'x', compacto: 'y' })).toBeNull();
    expect(normalizePreviews({ ...good, detalhado: '' })).toBeNull();
    expect(normalizePreviews({ ...good, padrao: 42 })).toBeNull();
    expect(normalizePreviews(null)).toBeNull();
    expect(normalizePreviews('boom')).toBeNull();
  });
});

describe('normalizeCartaoResponse expõe previews (SCRUM-99)', () => {
  const previews = {
    padrao: '💈 Zé\n📅 DIA: quinta-feira / ⏰ HORARIO: 15:00\nResponda SIM para confirmar. ✅',
    compacto: '💈 Zé — 📅 quinta-feira',
    detalhado: '💈 Zé\n📅 DIA: quinta-feira',
  };

  it('editável carrega previews do backend', () => {
    const st = normalizeCartaoResponse(editableRaw({ previews }));
    if (st.status !== 'editable') throw new Error('esperado editable');
    expect(st.previews).toEqual(previews);
  });

  it('travado carrega previews do backend', () => {
    const st = normalizeCartaoResponse(lockedRaw('prompt_custom', { previews }));
    if (st.status !== 'locked') throw new Error('esperado locked');
    expect(st.previews).toEqual(previews);
  });

  it('sem previews (contrato antigo/estranho) → null (a UI cai no fallback client)', () => {
    const st = normalizeCartaoResponse(editableRaw());
    if (st.status !== 'editable') throw new Error('esperado editable');
    expect(st.previews).toBeNull();
  });
});

/**
 * partirNegrito — a prévia do portal tem que mostrar o cartão como o cliente RECEBE no
 * WhatsApp, não a marcação crua. O Bruno pegou `*barbearia DRAGON*` com os asteriscos à
 * mostra no smoke visual (01/08); estes casos travam o comportamento.
 */
describe('partirNegrito (negrito do WhatsApp na prévia)', () => {
  it('extrai o trecho em negrito e some com os asteriscos', () => {
    expect(partirNegrito('*Barbearia X*')).toEqual([{ texto: 'Barbearia X', negrito: true }]);
  });

  it('preserva o texto ao redor', () => {
    expect(partirNegrito('💈 *Barbearia X* fecha às 20h')).toEqual([
      { texto: '💈 ', negrito: false },
      { texto: 'Barbearia X', negrito: true },
      { texto: ' fecha às 20h', negrito: false },
    ]);
  });

  it('texto sem marcação vira uma parte só', () => {
    expect(partirNegrito('Dia: quinta-feira')).toEqual([
      { texto: 'Dia: quinta-feira', negrito: false },
    ]);
  });

  it('asterisco solto/ímpar fica literal (igual ao WhatsApp)', () => {
    expect(partirNegrito('2 * 3 = 6')).toEqual([{ texto: '2 * 3 = 6', negrito: false }]);
    expect(partirNegrito('*sem fechar')).toEqual([{ texto: '*sem fechar', negrito: false }]);
  });

  it('não casa através de quebra de linha nem par vazio', () => {
    expect(partirNegrito('*abre\nfecha*')).toEqual([{ texto: '*abre\nfecha*', negrito: false }]);
    expect(partirNegrito('**')).toEqual([{ texto: '**', negrito: false }]);
  });

  it('string vazia → nenhuma parte', () => {
    expect(partirNegrito('')).toEqual([]);
  });

  it('reconstrução: juntar as partes devolve o texto sem os asteriscos do negrito', () => {
    const cartao = '💈 *Barbearia do Zé*\n\n📅 Dia: quinta\n\n✅ Responda SIM para confirmar.';
    const junto = partirNegrito(cartao)
      .map((p) => p.texto)
      .join('');
    expect(junto).toBe(cartao.replace(/\*([^*\n]+)\*/g, '$1'));
    expect(junto).not.toContain('*');
  });
});
