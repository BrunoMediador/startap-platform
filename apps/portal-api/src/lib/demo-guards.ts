/**
 * Guardas anti-abuso/custo da demo pública de IA (Missão 023 W6).
 *
 * A demo é um endpoint ANÔNIMO (POST /demo/chat) — é o maior risco de custo do
 * projeto. Camadas, da mais barata pra mais cara (rejeita cedo, ANTES de chamar o
 * LLM):
 *   1. rate-limit por IP (janela + burst)        — Redis INCR + EXPIRE
 *   2. teto de mensagens por sessão de visitante  — Redis INCR + EXPIRE
 *   3. hard cap GLOBAL diário (nº de chamadas LLM)— Redis INCR com TTL até o fim do dia
 *   4. sanitização do input (strip {{ }} + \n)    — sempre role:user
 *
 * Contadores no Redis (NÃO em memória do processo): janela não pode resetar a cada
 * restart nem divergir entre instâncias (mesmo racional do rate-limit do signup,
 * PR #268). Redis já é dependência dura do portal (sessões). Se cair, os checks
 * degradam FAIL-CLOSED (negam o turn) — nunca deixam a demo aberta a abuso por
 * causa de uma falha de infra; o LLM (custo real) só roda com o Redis saudável.
 *
 * Todas as chaves têm TTL nativo (auto-expiram): nada a limpar com cron. Ver
 * nota "agendamento fake" em demo-chat.ts.
 *
 * LGPD: o IP nunca vira chave em claro nem entra em log — é hasheado (ipHash).
 */
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { config } from '../config.js';

const NS = 'demo:'; // namespace de todas as chaves da demo no Redis
const SESSION_TTL_SECONDS = 60 * 60; // teto por sessão expira em 1h de inatividade

export type BlockedReason = 'rate_ip' | 'burst_ip' | 'session_cap' | 'daily_cap';

export interface GuardResult {
  ok: boolean;
  /** Preenchido só quando ok=false. */
  reason?: BlockedReason;
}

/** Hash curto e estável do IP pra chave/log (LGPD: IP nunca em claro). */
export function ipHash(ip: string): string {
  const salt = config.DEMO_IP_HASH_SALT ?? 'demo-ip-salt-v1';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

/** YYYY-MM-DD em America/Sao_Paulo (dia do hard cap global). */
export function spDateKey(now = new Date()): string {
  // en-CA => YYYY-MM-DD; timeZone garante o "dia" do negócio (BRT), não UTC.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Segundos até a virada do dia (BRT) — TTL da chave de cap diário. */
function secondsUntilEndOfSpDay(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
  const remaining = 86_400 - elapsed;
  // +60s de folga e teto em 86_400 (nunca <=0).
  return Math.min(86_400, Math.max(60, remaining + 60));
}

/** INCR + EXPIRE atômico (EXPIRE só na 1ª escrita da janela). Retorna o contador. */
async function bumpWindow(redis: Redis, key: string, ttlSeconds: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

/**
 * Sanitiza o texto do visitante ANTES de virar role:user:
 *  - remove delimitadores de placeholder {{ }} (mesma ideia do
 *    sanitizeNomeInjetavel do provisioning) pra não injetar marcador,
 *  - colapsa quebras de linha (anti "instrução em nova linha"),
 *  - trunca em DEMO_MAX_INPUT_CHARS (input bounded = custo bounded).
 * O texto JAMAIS é concatenado ao system prompt; vai sempre como mensagem do user.
 */
export function sanitizeDemoInput(raw: string): string {
  const stripped = raw
    .replace(/\{\{|\}\}/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const max = config.DEMO_MAX_INPUT_CHARS;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/**
 * Roda as guardas de IP + sessão (camadas 1 e 2). NÃO consome o cap diário
 * (esse é cobrado só quando o turn vai REALMENTE chamar o LLM — ver
 * reserveDailyCall). Fail-closed: erro de Redis => nega o turn.
 */
export async function checkIpAndSession(
  redis: Redis,
  ipHashed: string,
  sessionId: string,
): Promise<GuardResult> {
  try {
    // Burst (rajada curta) primeiro — mais barato de estourar, corta scraper rápido.
    const burst = await bumpWindow(
      redis,
      `${NS}rl:burst:${ipHashed}`,
      config.DEMO_BURST_WINDOW_SECONDS,
    );
    if (burst > config.DEMO_BURST_PER_IP) return { ok: false, reason: 'burst_ip' };

    const perIp = await bumpWindow(
      redis,
      `${NS}rl:ip:${ipHashed}`,
      config.DEMO_RATE_WINDOW_SECONDS,
    );
    if (perIp > config.DEMO_RATE_PER_IP) return { ok: false, reason: 'rate_ip' };

    const perSession = await bumpWindow(redis, `${NS}sess:${sessionId}`, SESSION_TTL_SECONDS);
    if (perSession > config.DEMO_MSG_PER_SESSION) return { ok: false, reason: 'session_cap' };

    return { ok: true };
  } catch {
    // Redis down: fail-closed. A demo (custo) não roda sem contador confiável.
    return { ok: false, reason: 'rate_ip' };
  }
}

export interface DailyReserveResult {
  ok: boolean;
  /** total de chamadas no dia após esta reserva (pra log/alerta). */
  count: number;
  /** true quando cruzou DEMO_DAILY_ALERT_AT (warn no log). */
  shouldAlert: boolean;
}

/**
 * Reserva 1 chamada no hard cap GLOBAL diário (camada 3). Atômico (INCR). Se o
 * contador PASSAR do teto, devolve ok=false (a chamada já foi contada, mas o turn
 * NÃO chama o LLM — o pequeno overshoot é inócuo e mais seguro que um GET+SET com
 * corrida). Fail-closed em erro de Redis.
 */
export async function reserveDailyCall(redis: Redis): Promise<DailyReserveResult> {
  const key = `${NS}spend:${spDateKey()}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, secondsUntilEndOfSpDay());
    }
    if (count > config.DEMO_DAILY_CALL_CAP) {
      return { ok: false, count, shouldAlert: false };
    }
    return {
      ok: true,
      count,
      shouldAlert: count === config.DEMO_DAILY_ALERT_AT,
    };
  } catch {
    return { ok: false, count: -1, shouldAlert: false };
  }
}
