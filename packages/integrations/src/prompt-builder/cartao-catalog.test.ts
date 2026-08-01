/**
 * Testes da validação de EMOJI LIVRE do cartão (decisão do Bruno, substitui a allowlist
 * fechada do SCRUM-92 inc.2 / ADR 0032).
 *
 * O que provamos:
 *  - aceita EXATAMENTE 1 emoji (grapheme cluster único), incluindo ZWJ legítimo e VS16;
 *  - rejeita TODO caso malicioso do enunciado (tag chars, ZWJ órfão, VS solto, controle,
 *    ZWSP, newline, múltiplos emojis, texto, dígito, espaço, pontuação, string vazia);
 *  - o sentinela de "desabilitado" (CARTAO_EMOJI_DISABLED) é aceito pelo validador do PUT
 *    mas NUNCA passa em isSingleValidEmoji (não é alcançável por digitação);
 *  - extractSeedEmojis extrai por POSIÇÃO/RÓTULO (não por membership num catálogo, que não
 *    existe mais) e não confunde chaves com o MESMO emoji (caso real: Samuel tem
 *    marca=servico=✂️).
 */
import { describe, expect, it } from 'vitest';
import { CARTAO_EMOJI_DISABLED } from './bloco-estrutural.js';
import {
  extractSeedEmojis,
  isEmojiAllowed,
  isSingleValidEmoji,
  isTemplateAllowed,
  validateCartaoEmojis,
} from './cartao-catalog.js';

// Tag chars U+E0000..U+E007F (o vetor de injeção que motivou a validação inteira).
const TAG_CHAR_1 = String.fromCodePoint(0xe0067);
const TAG_CHAR_CANCEL = String.fromCodePoint(0xe007f);
const ZWJ = String.fromCodePoint(0x200d);
const VS16 = String.fromCodePoint(0xfe0f);
const ZWSP = String.fromCodePoint(0x200b);

describe('isSingleValidEmoji — casos VÁLIDOS', () => {
  it('aceita um emoji simples', () => {
    expect(isSingleValidEmoji('💈')).toBe(true);
  });

  it('aceita emoji com variation selector (✂️ = U+2702 U+FE0F)', () => {
    expect(isSingleValidEmoji('✂️')).toBe(true);
  });

  it('aceita sequência ZWJ legítima (família 👨‍👩‍👧)', () => {
    expect(isSingleValidEmoji('👨‍👩‍👧')).toBe(true);
  });

  it('aceita emoji fora do antigo catálogo curado (emoji livre de verdade)', () => {
    expect(isSingleValidEmoji('🎩')).toBe(true);
    expect(isSingleValidEmoji('🌟')).toBe(true);
  });
});

describe('isSingleValidEmoji — casos MALICIOSOS/INVÁLIDOS (todos DEVEM ser rejeitados)', () => {
  it('rejeita emoji + tag chars (U+E0000-E007F) coladas', () => {
    expect(isSingleValidEmoji(`💈${TAG_CHAR_1}${TAG_CHAR_CANCEL}`)).toBe(false);
  });

  it('rejeita emoji + letra (💈a)', () => {
    expect(isSingleValidEmoji('💈a')).toBe(false);
  });

  it('rejeita 2 emojis (💈💈)', () => {
    expect(isSingleValidEmoji('💈💈')).toBe(false);
  });

  it('rejeita letra sozinha (a)', () => {
    expect(isSingleValidEmoji('a')).toBe(false);
  });

  it('rejeita espaço', () => {
    expect(isSingleValidEmoji(' ')).toBe(false);
  });

  it('rejeita pontuação (.)', () => {
    expect(isSingleValidEmoji('.')).toBe(false);
  });

  it('rejeita string vazia', () => {
    expect(isSingleValidEmoji('')).toBe(false);
  });

  it('rejeita ZWJ órfão (sozinho, sem sequência)', () => {
    expect(isSingleValidEmoji(ZWJ)).toBe(false);
  });

  it('rejeita variation selector solto (sozinho, sem base)', () => {
    expect(isSingleValidEmoji(VS16)).toBe(false);
  });

  it('rejeita emoji + newline', () => {
    expect(isSingleValidEmoji('💈\n')).toBe(false);
  });

  it('rejeita emoji + caractere de controle', () => {
    expect(isSingleValidEmoji(`💈${String.fromCharCode(1)}`)).toBe(false);
    expect(isSingleValidEmoji('💈\t')).toBe(false);
  });

  it('rejeita emoji + ZWSP (zero-width space)', () => {
    expect(isSingleValidEmoji(`💈${ZWSP}`)).toBe(false);
  });

  it('rejeita dígito', () => {
    expect(isSingleValidEmoji('1')).toBe(false);
  });

  it('rejeita tipo errado (não-string)', () => {
    expect(isSingleValidEmoji(42 as unknown)).toBe(false);
    expect(isSingleValidEmoji(null as unknown)).toBe(false);
    expect(isSingleValidEmoji(undefined as unknown)).toBe(false);
  });

  it('rejeita bandeira de SUBDIVISÃO (RGI_Emoji válida, mas CARREGA tag chars por design) — a defesa em profundidade explícita', () => {
    // 🏴 + tag chars da Inglaterra (gbeng). É um RGI_Emoji legítimo (bandeira reconhecida), mas
    // o deny-list de tag chars rejeita por cima — não confiamos cegamente no RGI_Emoji sozinho.
    const bandeiraSubdivisao = String.fromCodePoint(
      0x1f3f4,
      0xe0067,
      0xe0062,
      0xe0065,
      0xe006e,
      0xe0067,
      0xe007f,
    );
    expect(isSingleValidEmoji(bandeiraSubdivisao)).toBe(false);
  });
});

describe('isEmojiAllowed — wrapper compat (emoji livre, chave não restringe mais)', () => {
  it('delega em isSingleValidEmoji independente da chave', () => {
    expect(isEmojiAllowed('marca', '🎩')).toBe(true);
    expect(isEmojiAllowed('valor', '🎩')).toBe(true);
    expect(isEmojiAllowed('confirma', 'DROP TABLE')).toBe(false);
  });
});

describe('validateCartaoEmojis', () => {
  it('aceita override parcial de emoji livre e re-normaliza (NFC)', () => {
    const r = validateCartaoEmojis({ marca: '💈', servico: '🎩' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.emojis).toEqual({ marca: '💈', servico: '🎩' });
  });

  it('aceita o SENTINELA de desabilitado numa chave', () => {
    const r = validateCartaoEmojis({ marca: CARTAO_EMOJI_DISABLED });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.emojis).toEqual({ marca: CARTAO_EMOJI_DISABLED });
  });

  it('chave desconhecida = rejeitada (anti mass-assignment)', () => {
    const r = validateCartaoEmojis({ hack: '💈' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalidKey).toBe('hack');
  });

  it('emoji malicioso (tag chars) = rejeitado com a chave ofensora', () => {
    const tagged = `💈${TAG_CHAR_1}`;
    const r = validateCartaoEmojis({ valor: tagged });
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

describe('template enum fechado (inalterado)', () => {
  it('só padrao/compacto/detalhado', () => {
    expect(isTemplateAllowed('padrao')).toBe(true);
    expect(isTemplateAllowed('compacto')).toBe(true);
    expect(isTemplateAllowed('detalhado')).toBe(true);
    expect(isTemplateAllowed('livre')).toBe(false);
    expect(isTemplateAllowed(undefined)).toBe(false);
  });
});

describe('extractSeedEmojis (seed do picker — extração por POSIÇÃO/RÓTULO, emoji livre)', () => {
  it('puxa os emojis presentes no texto, por posição/rótulo (template padrao)', () => {
    const cartao = [
      '💈 Barbearia do Zé',
      '📅 DIA: <dia> / ⏰ HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
      'Responda SIM para confirmar. ✅',
    ].join('\n');
    const seed = extractSeedEmojis(cartao);
    expect(seed.marca).toBe('💈');
    expect(seed.dia).toBe('📅');
    expect(seed.horario).toBe('⏰');
    expect(seed.servico).toBe('✂️');
    expect(seed.valor).toBe('💰');
    expect(seed.confirma).toBe('✅');
  });

  it('puxa emoji FORA do antigo catálogo curado (emoji livre de verdade)', () => {
    const cartao = ['🎩 Studio X', '🌟 DIA: <dia>', 'Responda SIM para confirmar. 🚀'].join('\n');
    const seed = extractSeedEmojis(cartao);
    expect(seed.marca).toBe('🎩');
    expect(seed.dia).toBe('🌟');
    expect(seed.confirma).toBe('🚀');
  });

  it('CRÍTICO (caso real do Samuel): marca e servico com o MESMO emoji não se confundem — extração é POSICIONAL', () => {
    const cartao = [
      '✂️ Barbearia Samuel',
      '📅 DIA: <dia> / ⏰ HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
      'Responda SIM para confirmar. ✅',
    ].join('\n');
    const seed = extractSeedEmojis(cartao);
    expect(seed.marca).toBe('✂️'); // 1ª linha
    expect(seed.servico).toBe('✂️'); // rótulo SERVICO — mesmo emoji, chave correta pela posição
    expect(seed.dia).toBe('📅');
  });

  it('estabelecimento: extrai PROFISSIONAL pelo rótulo', () => {
    const cartao = [
      '👤 PROFISSIONAL: <nome do profissional escolhido>',
      '📅 DIA: <dia> / 🕐 HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
      'Responda SIM para confirmar. ✅',
    ].join('\n');
    const seed = extractSeedEmojis(cartao);
    expect(seed.profissional).toBe('👤');
    expect(seed.horario).toBe('🕐');
  });

  it('texto sem emoji reconhecível → objeto vazio/parcial (best-effort, nunca lança)', () => {
    expect(extractSeedEmojis('cartão só texto sem ícone')).toEqual({});
    expect(extractSeedEmojis('')).toEqual({});
    expect(extractSeedEmojis(null)).toEqual({});
  });
});
