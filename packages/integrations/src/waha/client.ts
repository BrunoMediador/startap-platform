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

/** Baixa mídia (áudio/imagem) recebida — usa o campo media.url do payload WAHA.
 *  Aceita URL absoluta, path relativo, ou URL com host localhost/127.0.0.1
 *  (WAHA serializa media.url como "http://localhost:3000/api/files/..." se
 *  referenciando a si proprio; dentro do nosso container "localhost" eh a
 *  api, nao o WAHA — entao reescrevemos o host pro WAHA_URL do docker net). */
export async function downloadMedia(url: string): Promise<Buffer> {
  if (!url) throw new Error('Download media failed: URL vazia');
  let fullUrl: string;
  const localhostMatch = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.exec(url);
  if (localhostMatch) {
    const pathAndQuery = localhostMatch[3] ?? '/';
    fullUrl = `${WAHA_URL}${pathAndQuery}`;
  } else if (/^https?:\/\//i.test(url)) {
    fullUrl = url;
  } else {
    fullUrl = `${WAHA_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  }
  const res = await fetch(fullUrl, { headers: { 'X-Api-Key': WAHA_API_KEY } });
  if (!res.ok) throw new Error(`Download media failed: HTTP ${res.status} (url=${fullUrl.slice(0, 80)})`);
  return Buffer.from(await res.arrayBuffer());
}
