export {
  buildBlocoEstrutural,
  buildCartaoRuntimeBlock,
  mergeEmojis,
  resolveDefaultCartaoEmojis,
  allAreaDefaultEmojiSets,
  BLOCO_ESTRUTURAL_MARKER,
  CARTAO_EMOJI_KEYS,
  type BlocoEstruturalModo,
  type CartaoConfig,
  type CartaoEmojiKey,
  type CartaoTemplate,
} from './bloco-estrutural.js';
export {
  isEmojiAllowed,
  isTemplateAllowed,
  emojiCatalog,
  validateCartaoEmojis,
  extractSeedEmojis,
  CARTAO_TEMPLATES,
  type EmojiValidation,
} from './cartao-catalog.js';
export { extractBakedCartao, isCartaoFlipSafe, type CartaoExtract } from './cartao-extract.js';
