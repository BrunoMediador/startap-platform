/**
 * Circuit breaker Redis-backed por slot para o único efeito externo do CRM.
 * Redis indisponível fecha o envio: é melhor recusar a ação humana do que perder
 * o controle de uma integração WAHA instável.
 */
import { logger } from '@startap/core/logger';
import { getRedis } from './session.js';

const log = logger.child({ service: 'portal-api', module: 'crm-whatsapp-manual-circuit' });
const FAILURE_WINDOW_SECONDS = 60;
const OPEN_SECONDS = 60;
const FAILURE_LIMIT = 3;

function openKey(slot: string): string {
  return `portal:crm:whatsapp-manual:circuit:open:${slot}`;
}

function failuresKey(slot: string): string {
  return `portal:crm:whatsapp-manual:circuit:failures:${slot}`;
}

export async function isCrmWhatsAppManualCircuitClosed(slot: string): Promise<boolean> {
  try {
    return (await getRedis().exists(openKey(slot))) === 0;
  } catch {
    log.error({ slot }, 'circuit CRM WhatsApp indisponivel; envio negado');
    return false;
  }
}

export async function recordCrmWhatsAppManualFailure(slot: string): Promise<void> {
  try {
    const redis = getRedis();
    const failures = await redis.incr(failuresKey(slot));
    if (failures === 1) await redis.expire(failuresKey(slot), FAILURE_WINDOW_SECONDS);
    if (failures >= FAILURE_LIMIT) {
      await redis.set(openKey(slot), '1', 'EX', OPEN_SECONDS);
      await redis.del(failuresKey(slot));
      log.warn({ slot, failures }, 'circuit CRM WhatsApp aberto apos falhas WAHA');
    }
  } catch {
    // O request já falhou; não há ação compensatória segura sem Redis.
    log.error({ slot }, 'nao foi possivel registrar falha do circuit CRM WhatsApp');
  }
}

export async function recordCrmWhatsAppManualSuccess(slot: string): Promise<void> {
  try {
    await getRedis().del(failuresKey(slot));
  } catch {
    log.warn({ slot }, 'nao foi possivel limpar falhas do circuit CRM WhatsApp');
  }
}
