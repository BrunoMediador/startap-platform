/**
 * Contato de suporte da Startap (canal único de atendimento humano do portal).
 * Centralizado aqui pra não espalhar o número — todo link "Falar com o suporte"
 * deve usar SUPORTE_WHATSAPP_URL.
 */
export const SUPORTE_WHATSAPP_NUMERO = '553599115327';

export const SUPORTE_WHATSAPP_URL = `https://wa.me/${SUPORTE_WHATSAPP_NUMERO}`;

/**
 * URL de "Ajuda" da landing/cadastro (W12): mesmo número de suporte, com texto
 * pré-preenchido de visitante (dúvida antes de assinar). NÃO é número novo —
 * reusa SUPORTE_WHATSAPP_URL pra centralizar (regra de ouro: número único).
 */
export const AJUDA_WHATSAPP_URL = `${SUPORTE_WHATSAPP_URL}?text=${encodeURIComponent(
  'Olá! Vim pelo site da Startap e queria tirar uma dúvida sobre o robô de atendimento.',
)}`;

/**
 * Instagram público da Startap (W12) — handle @startap.ia. Centralizado aqui
 * junto dos canais públicos pra não espalhar o link.
 */
export const INSTAGRAM_HANDLE = 'startap.ia';

export const INSTAGRAM_URL = `https://instagram.com/${INSTAGRAM_HANDLE}`;
