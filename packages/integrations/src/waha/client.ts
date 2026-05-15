/**
 * Cliente WAHA — envia mensagens via WhatsApp.
 *
 * Substitui os nós "WAHA → Send a text message", "Start/Stop Typing", "Send Seen".
 */
import { logger } from '@startap/core/logger';

const WAHA_URL = process.env.WAHA_URL ?? 'http://waha:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY ?? '';

const log = logger.child({ module: 'waha' });

async function wahaPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WAHA_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.error({ path, status: res.status, body: text }, 'WAHA error');
    throw new Error(`WAHA ${path} -> HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface SendTextOpts {
  sessao: string;
  chatId: string; // ex: 5535999998888@c.us
  texto: string;
  /** Se true, mostra "digitando…" antes de enviar (humaniza). Default: true. */
  typing?: boolean;
  /** Delay artificial em ms antes de enviar (humaniza). */
  delayMs?: number;
}

export async function sendText(opts: SendTextOpts): Promise<void> {
  const { sessao, chatId, texto, typing = true, delayMs = 0 } = opts;
  if (typing) await startTyping(sessao, chatId);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  await wahaPost('/api/sendText', {
    session: sessao,
    chatId,
    text: texto,
  });
  if (typing) await stopTyping(sessao, chatId);
}

export async function startTyping(sessao: string, chatId: string): Promise<void> {
  await wahaPost('/api/startTyping', { session: sessao, chatId }).catch(() => {});
}

export async function stopTyping(sessao: string, chatId: string): Promise<void> {
  await wahaPost('/api/stopTyping', { session: sessao, chatId }).catch(() => {});
}

export async function sendSeen(sessao: string, chatId: string): Promise<void> {
  await wahaPost('/api/sendSeen', { session: sessao, chatId }).catch(() => {});
}

/** Envia mídia por URL (vídeo, imagem). */
export async function sendMedia(opts: {
  sessao: string;
  chatId: string;
  url: string;
  caption?: string;
  type: 'video' | 'image' | 'file';
}): Promise<void> {
  const endpoint =
    opts.type === 'video'
      ? '/api/sendVideo'
      : opts.type === 'image'
        ? '/api/sendImage'
        : '/api/sendFile';
  await wahaPost(endpoint, {
    session: opts.sessao,
    chatId: opts.chatId,
    file: { url: opts.url },
    caption: opts.caption,
  });
}

/** Baixa mídia (áudio/imagem) recebida — usa o campo media.url do payload WAHA. */
export async function downloadMedia(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'X-Api-Key': WAHA_API_KEY } });
  if (!res.ok) throw new Error(`Download media failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
