import { createHash } from 'node:crypto';
/**
 * Pausa automática por RESPOSTA HUMANA à mão (SCRUM-59 — "mesmo número IA + atendente").
 *
 * Quando a recepção responde À MÃO pelo celular (mensagem fromMe de texto que NÃO é uma
 * frase de pausa) num chat de cliente, o bot pausa AQUELE contato por um tempo e volta
 * sozinho; cada nova resposta humana renova o prazo (ver router.ts, ramo fromMe do modo
 * atendente). A pausa em si usa flow_pauses.expires_at (migration 071) — a leitura é lazy.
 *
 * CRUX: o próprio bot manda fromMe. A resposta que o bot envia via WAHA volta no webhook
 * como fromMe=true (eco). Se pausássemos em QUALQUER fromMe, o bot se auto-pausaria após
 * cada resposta. Este módulo distingue "humano digitou no aparelho" de "app enviou via API"
 * por um REGISTRO DE ECO no Redis: ao enviar uma resposta (base.ts), gravamos uma marca
 * curta (session+telefone+hash do texto); o webhook fromMe cujo texto bate na marca = eco
 * do bot → ignora (não pausa, não casa keyword). Escolha do mecanismo (vs. rastrear
 * payload.id da engine): o id de envio↔eco NÃO é garantido igual na imagem WAHA congelada
 * (NOWEB), enquanto o TEXTO do eco é idêntico ao enviado — fingerprint de texto é robusto
 * sem depender de campo interno não-documentado da engine.
 *
 * Semântica de falha (fail-safe): na dúvida NUNCA auto-pausa (não arrisca auto-pausar o
 * bot). Redis fora/timeout no CHECK => 'degraded' => o chamador trata como eco pra fins de
 * auto-pausa (não pausa). O registro é best-effort e nunca derruba o envio.
 */
import { logger } from '@startap/core/logger';
import { canonicalE164 } from '@startap/core/phone';
import { getRedis } from './redis.js';

const log = logger.child({ module: 'human-reply-pause' });

/**
 * TTL da pausa por resposta humana (v1 = 60 min, constante no código; personalização
 * por clone fica pra v2). Cada resposta humana subsequente renova este prazo.
 */
export const HUMAN_REPLY_PAUSE_TTL_MS = 60 * 60 * 1000;

/** TTL da marca de eco no Redis. O eco chega em segundos; 5 min é folga com sobra. */
const BOT_ECHO_TTL_SECONDS = 300;

/** Timeout curto pra nunca pendurar o hot path do webhook num hiccup de Redis. */
const REDIS_TIMEOUT_MS = 500;

export type EchoState = 'echo' | 'human' | 'degraded';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Normaliza o texto pro fingerprint: trim + colapsa espaços + minúsculas. O eco do
 *  WhatsApp é verbatim; a normalização só absorve diferenças triviais de espaço. */
function normalizeEchoText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Chave da marca de eco. O telefone é HASHEADO (P3a, defesa em profundidade — review
 *  security): sem PII em claro na chave => `KEYS bot-echo:*` não enumera número de cliente.
 *  Determinístico dos dois lados; canonicalE164 ainda casa envio↔eco mesmo se um lado vier
 *  com o 9º dígito e o outro não (extractPhone dá o mesmo nº do contato — remoteJid da
 *  conversa — no envio e no eco fromMe; canonicalE164 normaliza a identidade). */
function botEchoKey(session: string, telefone: string, text: string): string {
  const phoneHash = createHash('sha1')
    .update(canonicalE164(telefone) ?? telefone)
    .digest('hex')
    .slice(0, 20);
  const textHash = createHash('sha1').update(normalizeEchoText(text)).digest('hex').slice(0, 20);
  return `bot-echo:${session}:${phoneHash}:${textHash}`;
}

/**
 * Marca a resposta que o bot ACABOU de enviar, pra reconhecer o eco fromMe dela depois.
 * Best-effort: qualquer erro só loga (nunca lança, nunca afeta o envio). No-op pra texto
 * vazio (mídia sem texto não gera eco de texto).
 */
export async function registerBotReplyEcho(
  session: string,
  telefone: string,
  text: string,
): Promise<void> {
  if (!text || !text.trim()) return;
  try {
    const redis = getRedis();
    await withTimeout(
      redis.set(botEchoKey(session, telefone, text), '1', 'EX', BOT_ECHO_TTL_SECONDS),
      REDIS_TIMEOUT_MS,
      'redis.set',
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), session },
      'registerBotReplyEcho falhou (best-effort, ignorado)',
    );
  }
}

/**
 * Classifica uma mensagem fromMe: eco do próprio bot ('echo'), digitada por humano
 * ('human') ou indeterminado ('degraded', Redis indisponível). O chamador usa:
 *   - keyword match: só PULA em 'echo' (comando humano explícito deve funcionar mesmo em
 *     'degraded'; o risco de eco-com-keyword é remoto — validação da frase mitiga).
 *   - auto-pausa human_reply: só age em 'human' (fail-safe: 'echo' e 'degraded' NÃO pausam).
 */
export async function isBotEcho(
  session: string,
  telefone: string,
  text: string,
): Promise<EchoState> {
  if (!text || !text.trim()) return 'human';
  try {
    const redis = getRedis();
    const res = await withTimeout(
      redis.get(botEchoKey(session, telefone, text)),
      REDIS_TIMEOUT_MS,
      'redis.get',
    );
    return res ? 'echo' : 'human';
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), session },
      'isBotEcho: Redis indisponível — degraded (não auto-pausa)',
    );
    return 'degraded';
  }
}

/**
 * Self-chat: a mensagem fromMe é pro PRÓPRIO número da sessão (ex.: eco do alerta de lead
 * no cenário mesmo-número). Compara identidade canônica (canonicalE164 remove o 9º dígito
 * BR pra bater independente do formato). Self-chat NUNCA pausa nem comanda nada.
 */
export function isSelfChat(telefone: string, ownNumber: string | null | undefined): boolean {
  if (!ownNumber) return false;
  const a = canonicalE164(telefone);
  const b = canonicalE164(ownNumber);
  return a !== null && b !== null && a === b;
}
