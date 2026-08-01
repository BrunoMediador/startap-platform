export {
  buildBlocoEstrutural,
  buildCartaoRuntimeBlock,
  buildCartaoExemplo,
  buildCartaoExemploSegmentado,
  mergeEmojis,
  resolveDefaultCartaoEmojis,
  allAreaDefaultEmojiSets,
  BLOCO_ESTRUTURAL_MARKER,
  CARTAO_EMOJI_KEYS,
  CARTAO_EMOJI_DISABLED,
  type BlocoEstruturalModo,
  type CartaoConfig,
  type CartaoEmojiKey,
  type CartaoExemploSample,
  type CartaoExemploSegmento,
  type CartaoTemplate,
} from './bloco-estrutural.js';
export {
  isEmojiAllowed,
  isSingleValidEmoji,
  isTemplateAllowed,
  validateCartaoEmojis,
  extractSeedEmojis,
  CARTAO_TEMPLATES,
  type EmojiValidation,
} from './cartao-catalog.js';
export {
  extractBakedCartao,
  isCartaoFlipSafe,
  isCartaoRuntimeFlipBlocked,
  type CartaoExtract,
} from './cartao-extract.js';
