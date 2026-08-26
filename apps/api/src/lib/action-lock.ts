import { createHash, createHmac, randomUUID } from 'node:crypto';
/**
 * Lock de acao com efeito externo (ADR 0019, passo 3).
 *
 * O pior caso de duplicidade da API nao e a resposta dupla — e o EVENTO GCAL
 * DUPLICADO: o bot da barbearia cria um agendamento no Google Calendar e, se a
 * mesma mensagem for processada 2x (retry da WAHA, ou no futuro 2 instancias
 * atras de um LB), o cliente PAGANTE acaba com 2 eventos no calendario. Isto e
 * dano visivel.
 *
 * Este modulo da um lock distribuido CURTO em volta da ACAO idempotente,
 * chaveado por uma chave SEMANTICA da acao (ex.: este agendamento desta conversa
 * neste horario): quem ADQUIRE o lock executa a acao; quem NAO adquire PULA
 * (entende que a acao ja foi/esta sendo feita pelo outro processamento).
 *
 * Primitivo: SET <key> <token> NX PX <ttl>.
 *  - retorna 'OK'  -> adquiriu o lock -> EXECUTA a acao.
 *  - retorna null  -> outro ja segura o lock -> PULA (acao ja em andamento/feita).
 * Release: check-and-del via Lua (so apaga se o token for o nosso) — evita
 * liberar o lock de outro dono se o nosso TTL ja tiver expirado no meio. Se nao
 * liberarmos (crash), o PX faz o lock expirar sozinho: sem lock orfao.
 *
 * FAIL-OPEN (regra dura do ADR): se o Redis estiver inacessivel, der timeout ou
 * qualquer erro ao ADQUIRIR o lock, EXECUTAMOS a acao mesmo assim. Idempotencia
 * e protecao contra duplicata, nunca pode virar o ponto de falha que impede um
 * agendamento legitimo. Vira fail-closed so no scale-out (passo 5 do ADR,
 * decisao do Bruno).
 *
 * Com 1 instancia o SET NX sempre adquire (nunca ha corrida real), entao isto e
 * funcionalmente inocuo — o ganho real e no scale-out horizontal.
 *
 * Gate: a flag IDEMPOTENCY_ACTION_LOCK e checada PELO CHAMADOR (o bot). Com a
 * flag OFF o chamador nem invoca este modulo -> nenhuma conexao Redis, zero
 * mudanca de comportamento (cria o evento como hoje).
 */
import { logger } from '@startap/core/logger';
import { config } from '../config.js';
import { getRedis } from './redis.js';

const log = logger.child({ module: 'action-lock' });

/** Envolve uma promise com timeout; rejeita se estourar. */
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

// Release check-and-del: apaga a chave SO se o valor ainda for o nosso token.
// Evita que, apos o TTL expirar e outro dono pegar o lock, a gente apague o
// lock alheio. Roda no Redis (atomico).
const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export interface ActionLockResult<T> {
  /** true = adquiriu o lock e EXECUTOU a action; o resultado esta em `value`. */
  executed: boolean;
  /** Resultado da action quando executed=true; undefined quando pulou. */
  value?: T;
  /** true = Redis indisponivel/timeout no acquire -> executou via FAIL-OPEN. */
  degraded: boolean;
}

/**
 * Adquire um lock distribuido curto pela chave da acao e, SE adquirir, executa
 * `action`. Quem nao adquire PULA (executed=false). Fail-open em erro de Redis.
 *
 * NUNCA lanca por causa do Redis — so propaga erro vindo da PROPRIA `action`
 * (ex.: o GCal retornar 403). Erro de Redis no acquire -> fail-open (executa).
 *
 * @param key    chave semantica pseudonimizada (nunca contém telefone em claro)
 * @param action a operacao idempotente a proteger (criar evento + responder)
 */
export async function withActionLock<T>(
  key: string | null,
  action: () => Promise<T>,
): Promise<ActionLockResult<T>> {
  // Sem pepper dedicado não há identidade pseudonimizada segura para a chave. Degrada
  // exatamente como indisponibilidade do Redis: executa, mas não persiste PII no Redis.
  if (key === null) {
    log.warn({ status: 'disabled_missing_pepper' }, 'action-lock desabilitado: pepper ausente');
    return { executed: true, value: await action(), degraded: true };
  }
  const token = randomUUID();
  let acquired = false;
  try {
    const redis = getRedis();
    const res = await withTimeout(
      redis.set(key, token, 'PX', config.IDEMPOTENCY_ACTION_LOCK_TTL_MS, 'NX'),
      config.IDEMPOTENCY_REDIS_TIMEOUT_MS,
      'redis.set',
    );
    if (res !== 'OK') {
      // Outro processamento ja segura o lock -> a acao ja foi/esta sendo feita.
      log.info(
        { keyHash: safeKeyHash(key) },
        'action-lock nao adquirido — acao ja em andamento, pulando',
      );
      return { executed: false, degraded: false };
    }
    acquired = true;
  } catch (err) {
    // Redis indisponivel/timeout no acquire: FAIL-OPEN. Loga warn e executa
    // a acao mesmo assim (sem lock). Nao dropar agendamento legitimo.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), keyHash: safeKeyHash(key) },
      'action-lock Redis indisponivel — fail-open (executando acao sem lock)',
    );
    const value = await action();
    return { executed: true, value, degraded: true };
  }

  // Lock adquirido: executa a acao e libera no finally (check-and-del).
  try {
    const value = await action();
    return { executed: true, value, degraded: false };
  } finally {
    if (acquired) {
      try {
        await withTimeout(
          getRedis().eval(RELEASE_LUA, 1, key, token),
          config.IDEMPOTENCY_REDIS_TIMEOUT_MS,
          'redis.eval',
        );
      } catch (err) {
        // Falha ao liberar nao e fatal: o PX faz o lock expirar sozinho.
        log.warn(
          { err: err instanceof Error ? err.message : String(err), keyHash: safeKeyHash(key) },
          'action-lock falha ao liberar — expira por TTL',
        );
      }
    }
  }
}

/**
 * Monta a chave de lock para criacao de evento GCal.
 * Granularidade: este agendamento (slot+telefone) neste horario de inicio.
 * Duas mensagens distintas que pedem o MESMO horario para o MESMO cliente
 * batem na mesma chave -> 1 evento. O telefone e normalizado (so digitos) para
 * nao gerar chaves diferentes por formatacao (+55, espacos, @c.us).
 */
export function gcalActionLockKey(slot: string, telefone: string, startISO: string): string | null {
  const tel = telefone.replace(/\D/g, '');
  const pepper = config.ACTION_LOCK_PHONE_PEPPER;
  if (!pepper || pepper.length < 16 || tel.length < 10) return null;
  const contactHash = createHmac('sha256', pepper).update(tel, 'utf8').digest('hex');
  return `actionlock:gcal:${slot}:${contactHash}:${startISO}`;
}

function safeKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}
