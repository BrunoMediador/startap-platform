/**
 * Cliente WAHA — envia mensagens via WhatsApp.
 *
 * Substitui os nós "WAHA → Send a text message", "Start/Stop Typing", "Send Seen".
 */
import { logger } from '@startap/core/logger';
import { extractSentMessageId } from '@startap/core/message-ack';
import { DEFAULT_WAHA_SHARD_ID, resolveWahaUrl } from './shard.js';

const WAHA_API_KEY = process.env.WAHA_API_KEY ?? '';

const log = logger.child({ module: 'waha' });

/**
 * Resolve a URL base do WAHA para o shard (ADR 0020). Com a flag `WAHA_SHARDING`
 * OFF (default) IGNORA o shardId e devolve a WAHA_URL única de hoje — comportamento
 * idêntico ao de antes do sharding. shardId default = shard 0 (`automacoes-waha-1`).
 */
function wahaUrl(shardId: number = DEFAULT_WAHA_SHARD_ID): string {
  return resolveWahaUrl(shardId);
}

/**
 * Endpoints best-effort/cosméticos (presença/visto): o callsite já engole o erro
 * com `.catch(() => {})` porque falhar não afeta a conversa. O erro deles vira
 * `debug` em vez de `error` pra não poluir o log.
 *
 * Caso concreto: `/api/sendSeen` responde 400 "Enable NOWEB store" em TODA
 * mensagem das sessões antigas (criadas com store off) — ruído puro, não
 * incidente. Sessões novas nascem com store on (clone-provisioning) e param de
 * dar 400; as antigas só zeram o ruído num re-pareamento natural.
 */
const BEST_EFFORT_PATHS = new Set(['/api/sendSeen', '/api/startTyping', '/api/stopTyping']);

async function wahaPost<T = unknown>(
  path: string,
  body: unknown,
  shardId: number = DEFAULT_WAHA_SHARD_ID,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${wahaUrl(shardId)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    // A resposta pode ecoar chatId/texto. Não lemos nem registramos o corpo para
    // evitar PII de mensagens outbound em todo caller deste cliente compartilhado.
    // Endpoints cosméticos (visto/presença) não merecem nível error — o callsite
    // já trata como best-effort. Envios reais (sendText/sendMedia) seguem error.
    const level = BEST_EFFORT_PATHS.has(path) ? 'debug' : 'error';
    log[level]({ path, status: res.status }, 'WAHA error');
    throw new Error(`WAHA ${path} -> HTTP ${res.status}`);
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
  /**
   * Shard do container WAHA da sessão (ADR 0020). Opcional; default shard 0
   * (`automacoes-waha-1`, onde tudo vive hoje). Com a flag `WAHA_SHARDING` OFF é
   * ignorado — sempre a WAHA_URL única de hoje.
   */
  shardId?: number;
  /** AbortSignal do caller para impor deadline explícito ao fetch WAHA. */
  signal?: AbortSignal;
}

/** Resultado do envio. `messageId` = id serializado do WAHA da mensagem enviada, quando extraível
 *  (rastreio de entrega — SCRUM-58). null = a resposta não trouxe id conhecido (2026.6.2 nem sempre
 *  traz id no topo — waha.md); o envio funcionou, só não há como correlacionar o ack daquele
 *  outbound. Todos os callers atuais ignoram o retorno (compat retroativa). */
export interface SendTextResult {
  messageId: string | null;
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function sendText(opts: SendTextOpts): Promise<SendTextResult> {
  const {
    sessao,
    chatId,
    texto,
    typing = true,
    delayMs = 0,
    shardId = DEFAULT_WAHA_SHARD_ID,
    signal,
  } = opts;
  if (typing) await startTyping(sessao, chatId, shardId, signal);
  try {
    await waitForDelay(delayMs, signal);
    const res = await wahaPost<unknown>(
      '/api/sendText',
      {
        session: sessao,
        chatId,
        text: texto,
      },
      shardId,
      signal,
    );
    // Extração best-effort do id (rastreio de entrega). NUNCA lança — se não achar, messageId=null.
    return { messageId: extractSentMessageId(res) };
  } finally {
    // Mesmo se sendText abortar/falhar, não deixamos o cliente preso em typing.
    // O stop é best-effort, mas nunca fica pendurado após o deadline principal.
    if (typing) await stopTyping(sessao, chatId, shardId, AbortSignal.timeout(3_000));
  }
}

export async function startTyping(
  sessao: string,
  chatId: string,
  shardId: number = DEFAULT_WAHA_SHARD_ID,
  signal?: AbortSignal,
): Promise<void> {
  await wahaPost('/api/startTyping', { session: sessao, chatId }, shardId, signal).catch(() => {});
}

export async function stopTyping(
  sessao: string,
  chatId: string,
  shardId: number = DEFAULT_WAHA_SHARD_ID,
  signal?: AbortSignal,
): Promise<void> {
  await wahaPost('/api/stopTyping', { session: sessao, chatId }, shardId, signal).catch(() => {});
}

export async function sendSeen(
  sessao: string,
  chatId: string,
  shardId: number = DEFAULT_WAHA_SHARD_ID,
): Promise<void> {
  await wahaPost('/api/sendSeen', { session: sessao, chatId }, shardId).catch(() => {});
}

/** Envia mídia por URL (vídeo, imagem). */
export async function sendMedia(opts: {
  sessao: string;
  chatId: string;
  url: string;
  caption?: string;
  type: 'video' | 'image' | 'file';
  /** Shard do container WAHA (ADR 0020). Default shard 0. Ignorado com flag OFF. */
  shardId?: number;
}): Promise<void> {
  const endpoint =
    opts.type === 'video'
      ? '/api/sendVideo'
      : opts.type === 'image'
        ? '/api/sendImage'
        : '/api/sendFile';
  await wahaPost(
    endpoint,
    {
      session: opts.sessao,
      chatId: opts.chatId,
      file: { url: opts.url },
      caption: opts.caption,
    },
    opts.shardId ?? DEFAULT_WAHA_SHARD_ID,
  );
}

/** Baixa mídia (áudio/imagem) recebida — usa o campo media.url do payload WAHA.
 *  Aceita URL absoluta, path relativo, ou URL com host localhost/127.0.0.1
 *  (WAHA serializa media.url como "http://localhost:3000/api/files/..." se
 *  referenciando a si proprio; dentro do nosso container "localhost" eh a
 *  api, nao o WAHA — entao reescrevemos o host pro WAHA_URL do docker net). */
export async function downloadMedia(
  url: string,
  shardId: number = DEFAULT_WAHA_SHARD_ID,
): Promise<Buffer> {
  if (!url) throw new Error('Download media failed: URL vazia');
  const base = wahaUrl(shardId);
  let fullUrl: string;
  const localhostMatch = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.exec(url);
  if (localhostMatch) {
    const pathAndQuery = localhostMatch[3] ?? '/';
    fullUrl = `${base}${pathAndQuery}`;
  } else if (/^https?:\/\//i.test(url)) {
    fullUrl = url;
  } else {
    fullUrl = `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  }
  const res = await fetch(fullUrl, { headers: { 'X-Api-Key': WAHA_API_KEY } });
  if (!res.ok)
    throw new Error(`Download media failed: HTTP ${res.status} (url=${fullUrl.slice(0, 80)})`);
  return Buffer.from(await res.arrayBuffer());
}
