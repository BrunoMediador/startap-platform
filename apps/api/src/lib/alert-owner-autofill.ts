/**
 * alert-owner-autofill — preenche flow_clones.alert_owner_phone com o número da
 * PRÓPRIA sessão WhatsApp conectada (me.id) quando a sessão fica WORKING.
 *
 * POR QUÊ (decisão do Bruno): clones provisionados ANTES de conectar nascem com
 * alert_owner_phone VAZIO. Como alert_owner_enabled=true por default, o alerta ao
 * dono (cancelamento escalado / client-alert.ts) ficava SEM DESTINO (`no_owner`) e
 * se perdia. Nada gravava o telefone no momento da conexão. Os 2 pagantes provam o
 * padrão: o telefone de alerta É o número conectado da sessão (Cirilo 5511979630828,
 * Samuel ...6797). Este hook fecha o gap sem depender de preenchimento manual.
 *
 * DESENHO (espelha o fail-safe do trial-pairing):
 *  - Só age em status WORKING + me.id disponível.
 *  - SOMENTE preenche se a coluna estiver vazia (UPDATE ... WHERE alert_owner_phone
 *    IS NULL/''). NUNCA sobrescreve override manual nem o backfill da 050. O guard
 *    mora no próprio UPDATE → idempotente, sem TOCTOU.
 *  - Escopado por slot (flow_clones é a âncora do tenant).
 *  - Normaliza o me.id para DÍGITOS PUROS preservando o 9 (meIdToDigits), MESMO
 *    formato já gravado nos pagantes. NÃO usa canonicalE164 (removeria o 9 e
 *    divergiria do formato existente).
 *  - Fire-and-forget / fail-safe ABSOLUTO: qualquer falha é capturada e logada —
 *    NUNCA propaga pro webhook WAHA (que precisa de 2xx) nem afeta o trial-pairing.
 *  - LGPD: telefone NUNCA logado em claro — só phoneHint (DDD + 2 últimos).
 */
import { logger } from '@startap/core/logger';
import { meIdToDigits, phoneHint } from '@startap/core/phone';
import { flowClones } from '@startap/db';

const log = logger.child({ module: 'alert-owner-autofill' });

export type AlertOwnerAutofillResult =
  | { status: 'filled'; slot: string }
  | { status: 'skipped'; reason: 'already-set-or-not-clone' | 'bad-me-id' }
  | { status: 'error' };

/**
 * Tenta preencher alert_owner_phone do clone (pelo slot) com o número da sessão.
 * Nunca lança. Chamado pelo hook de session.status WORKING.
 *
 * @param slot  slot do clone (resolvido pela sessão pelo chamador).
 * @param meId  me.id cru do WAHA (ex.: "5511979630828@c.us"); pode ser null.
 */
export async function autofillAlertOwnerPhone(
  slot: string,
  meId: string | null,
): Promise<AlertOwnerAutofillResult> {
  try {
    // Normaliza só p/ validar/logar o hint; a gravação re-normaliza dentro da query
    // (fonte de verdade do formato gravado). meIdToDigits preserva o 9.
    const digits = meId ? meIdToDigits(meId) : null;
    if (!digits) {
      log.warn({ slot }, 'alert-owner-autofill: me.id ausente/inválido — não preenche');
      return { status: 'skipped', reason: 'bad-me-id' };
    }

    const filled = await flowClones.setCloneAlertOwnerPhoneIfEmpty(slot, meId ?? '');
    if (!filled) {
      // Já tinha valor (override/backfill) ou o slot não é clone — no-op idempotente.
      return { status: 'skipped', reason: 'already-set-or-not-clone' };
    }

    log.info(
      { slot, ownerHint: phoneHint(digits) },
      'alert-owner-autofill: alert_owner_phone preenchido do número da sessão',
    );
    return { status: 'filled', slot };
  } catch (e) {
    // Fail-safe: NUNCA quebra o webhook nem o pareamento de trial.
    log.error(
      { slot, err: e instanceof Error ? e.message : String(e) },
      'alert-owner-autofill: falha ao preencher (ignorado, não afeta webhook/trial)',
    );
    return { status: 'error' };
  }
}
