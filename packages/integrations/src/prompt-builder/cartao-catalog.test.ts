/**
 * Testes da ALLOWLIST FECHADA de emoji (SCRUM-92 inc.2, decisão do security).
 *
 * O que provamos:
 *  - membership por sequência INTEIRA + NFC (não por categoria/grapheme);
 *  - TAG CHARS (U+E00xx) coladas num emoji válido = REJEITADO (o furo que grapheme deixaria);
 *  - fora do catálogo / chave desconhecida / tipo errado = rejeitado;
 *  - TODO default por área é membro do catálogo (o picker nunca oferece algo que o backend nega);
 *  - paridade com o catálogo da UI (feat/scrum92-cartao-config-ui) — contrato compartilhado;
 *  - extractSeedEmojis puxa os emojis de um cartão capturado só quando estão na allowlist.
 */
import { describe, expect, it } from 'vitest';
import {
  CARTAO_EMOJI_KEYS,
  allAreaDefaultEmojiSets,
  resolveDefaultCartaoEmojis,
} from './bloco-estrutural.js';
import {
  emojiCatalog,
  extractSeedEmojis,
  isEmojiAllowed,
  isTemplateAllowed,
  validateCartaoEmojis,
} from './cartao-catalog.js';

// Espelho do catálogo do picker da UI (apps/portal-web/src/lib/cartao-config.ts EMOJI_CATALOG).
// Se a UI mudar, este espelho muda junto — o teste é o guarda do contrato compartilhado.
const UI_CATALOG: Record<string, string[]> = {
  marca: ['💈', '💇', '💅', '💆', '✂️', '📅', '🌻'],
  dia: ['📅', '🗓️', '📆'],
  horario: ['⏰', '🕐', '⌚'],
  servico: ['✂️', '💇', '💅', '✨', '📋', '📝'],
  valor: ['💰', '💵', '💲', '🪙'],
  confirma: ['✅', '☑️', '👍'],
  profissional: ['👤', '🧑‍🔧', '💇‍♂️'],
};

describe('allowlist — membership exata (NFC + sequência inteira)', () => {
  it('aceita um emoji do catálogo daquela chave', () => {
    expect(isEmojiAllowed('marca', '💈')).toBe(true);
    expect(isEmojiAllowed('confirma', '✅')).toBe(true);
    expect(isEmojiAllowed('valor', '💵')).toBe(true);
  });

  it('REJEITA emoji certo na chave ERRADA (catálogo é por chave)', () => {
    // 🪙 é válido em valor, não em confirma.
    expect(isEmojiAllowed('valor', '🪙')).toBe(true);
    expect(isEmojiAllowed('confirma', '🪙')).toBe(false);
  });

  it('REJEITA tag chars (U+E00xx) coladas num emoji válido — o furo do grapheme', () => {
    const tagged = `💈${String.fromCodePoint(0xe0067)}${String.fromCodePoint(0xe007f)}`;
    expect(isEmojiAllowed('marca', tagged)).toBe(false);
    const check = validateCartaoEmojis({ marca: tagged });
    expect(check.ok).toBe(false);
  });

  it('REJEITA texto arbitrário, string vazia e tipo errado', () => {
    expect(isEmojiAllowed('marca', 'DROP TABLE')).toBe(false);
    expect(isEmojiAllowed('marca', '')).toBe(false);
    expect(isEmojiAllowed('marca', 42 as unknown)).toBe(false);
    expect(isEmojiAllowed('marca', null as unknown)).toBe(false);
  });
});

describe('validateCartaoEmojis', () => {
  it('aceita override parcial e re-normaliza (NFC) os valores', () => {
    const r = validateCartaoEmojis({ marca: '💈', servico: '✨' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.emojis).toEqual({ marca: '💈', servico: '✨' });
  });

  it('chave desconhecida = rejeitada (anti mass-assignment)', () => {
    const r = validateCartaoEmojis({ hack: '💈' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalidKey).toBe('hack');
  });

  it('valor fora do catálogo = rejeitado com a chave ofensora', () => {
    const r = validateCartaoEmojis({ valor: '🎩' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalidKey).toBe('valor');
  });

  it('objeto ausente/nulo = ok vazio (override parcial legítimo)', () => {
    expect(validateCartaoEmojis(undefined)).toEqual({ ok: true, emojis: {} });
    expect(validateCartaoEmojis(null)).toEqual({ ok: true, emojis: {} });
  });

  it('não-objeto = rejeitado', () => {
    expect(validateCartaoEmojis('💈').ok).toBe(false);
  });
});

describe('template enum fechado', () => {
  it('só padrao/compacto/detalhado', () => {
    expect(isTemplateAllowed('padrao')).toBe(true);
    expect(isTemplateAllowed('compacto')).toBe(true);
    expect(isTemplateAllowed('detalhado')).toBe(true);
    expect(isTemplateAllowed('livre')).toBe(false);
    expect(isTemplateAllowed(undefined)).toBe(false);
  });
});

describe('catálogo cobre defaults e casa a UI', () => {
  it('TODO default por área é membro do catálogo daquela chave', () => {
    for (const set of allAreaDefaultEmojiSets()) {
      for (const k of CARTAO_EMOJI_KEYS) {
        expect(isEmojiAllowed(k, set[k])).toBe(true);
      }
    }
  });

  it('defaults por área do endpoint são todos válidos (agenda + estabelecimento)', () => {
    for (const modo of ['agenda', 'estabelecimento'] as const) {
      for (const area of ['barbearia', 'salao', 'manicure', 'estetica', null]) {
        const d = resolveDefaultCartaoEmojis(modo, area);
        for (const k of CARTAO_EMOJI_KEYS) expect(isEmojiAllowed(k, d[k])).toBe(true);
      }
    }
  });

  it('o conjunto do catálogo é IGUAL ao do picker da UI (contrato compartilhado)', () => {
    const backend = emojiCatalog();
    for (const k of CARTAO_EMOJI_KEYS) {
      expect(new Set(backend[k])).toEqual(new Set(UI_CATALOG[k].map((e) => e.normalize('NFC'))));
    }
  });
});

describe('extractSeedEmojis (seed do picker a partir do cartão capturado)', () => {
  it('puxa os emojis presentes no texto, por chave', () => {
    const cartao = [
      '[CARTAO DE CONFIRMACAO]',
      '💈 Barbearia do Zé',
      '📅 DIA: <dia> / ⏰ HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
      'Responda SIM ✅',
    ].join('\n');
    const seed = extractSeedEmojis(cartao);
    expect(seed.marca).toBe('💈');
    expect(seed.dia).toBe('📅');
    expect(seed.horario).toBe('⏰');
    expect(seed.servico).toBe('✂️');
    expect(seed.valor).toBe('💰');
    expect(seed.confirma).toBe('✅');
  });

  it('texto sem emoji de catálogo → objeto vazio (best-effort, nunca lança)', () => {
    expect(extractSeedEmojis('cartão só texto sem ícone')).toEqual({});
    expect(extractSeedEmojis('')).toEqual({});
    expect(extractSeedEmojis(null)).toEqual({});
  });
});
