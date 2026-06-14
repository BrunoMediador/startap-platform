/**
 * client-alert — envio de alerta de CANCELAMENTO pro DONO do clone (Missão 023 W5).
 *
 * Quando o cliente final pede cancelamento ao bot de um barbeiro, o bot NÃO cancela
 * (não há tool de delete no GCal). Ele ESCALA: dispara 1 WhatsApp pro dono do clone
 * (flow_clones.alert_owner_phone, migration 050) pela sessão remetente `ALERTAS`
 * (W3 / migration 049, resolvida por alert_config.sender_slot → bot_config.waha_sessao).
 *
 * DESENHO (regras de ouro + design W5):
 *  - DORMENTE por flag: o gate macro `CANCELAMENTO_ESCALADO_ENABLED` (default OFF) é
 *    checado pelo CHAMADOR (a tool no bot). Este módulo, se chamado, tenta enviar; mas
 *    com a flag OFF a tool nem chega aqui. Toggle fino por-clone = alert_owner_enabled.
 *  - LGPD-safe: a mensagem ao dono leva só um phone_hint do cliente (5535****1234),
 *    o nome do clone e a referência de horário como o cliente falou. NUNCA telefone cru
 *    em log. NUNCA persiste o conteúdo da conversa.
 *  - Anti-flood: cooldown por (slot, hash do telefone do cliente) reusando a máquina
 *    alert_states (sem tabela nova). Repetir "cancelar" dentro da janela NÃO reenvia.
 *  - Fire-and-forget / fail-safe: QUALQUER falha (sem destino, sessão caída, timeout,
 *    erro de DB) é capturada e logada — NUNCA propaga pro atendimento. O bot sempre
 *    responde ao cliente, mesmo que o alerta não saia. Retorna o resultado pro log.
 *  - Idempotência de transporte: 1 disparo = 1 mensagem; o cooldown serializa repetições.
 */
import { createHash } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { alerts, flowClones } from '@startap/db';
import { waha } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ module: 'client-alert' });

/** Timeout duro do sendText — o caminho do bot nunca espera WAHA indefinidamente. */
const SEND_TIMEOUT_MS = 8000;

export type ClientAlertResult =
  | { ok: true; escalado: true }
  | { ok: true; escalado: false; reason: 'disabled' | 'no_owner' | 'cooldown' }
  | { ok: false; escalado: false; reason: 'send_failed' | 'error' };

/** Mascara telefone para log/mensagem (LGPD): 5535999991234 -> 5535****1234. */
export function phoneHint(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 8) return '***';
  return `${d.slice(0, 4)}****${d.slice(-4)}`;
}

/** check_key do cooldown: por slot + hash curto do telefone do cliente (sem PII na chave). */
function cooldownKey(slot: string, clienteTelefone: string): string {
  const h = createHash('sha256')
    .update(clienteTelefone.replace(/\D/g, ''))
    .digest('hex')
    .slice(0, 12);
  return `clientalert:${slot}:${h}`;
}

/** Normaliza E.164 (só dígitos) -> chatId WhatsApp. */
function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

/** Monta a mensagem LGPD-safe pro dono (phone_hint do cliente, nome do clone, referência). */
function buildOwnerMessage(input: {
  cloneDisplayName: string;
  clientePhoneHint: string;
  referenciaHorario: string;
  motivo: string;
}): string {
  const ref = input.referenciaHorario.trim() || 'não especificado';
  const motivo = input.motivo.trim();
  const linhas = [
    `Pedido de CANCELAMENTO no ${input.cloneDisplayName}.`,
    `Cliente: ${input.clientePhoneHint}`,
    `Horário citado: ${ref}`,
  ];
  if (motivo) linhas.push(`Motivo: ${motivo}`);
  linhas.push('Entre em contato com o cliente para resolver. (O bot NÃO cancelou nada.)');
  return linhas.join('\n');
}

/**
 * Verifica + reserva o cooldown anti-flood. Retorna true se PODE enviar (e marca o envio),
 * false se ainda está na janela. Fail-open: erro de DB no check NÃO bloqueia o envio
 * (preferimos avisar o dono a silenciar por falha de infra).
 */
async function reserveCooldown(checkKey: string, cooldownMin: number): Promise<boolean> {
  try {
    const state = await alerts.getState(checkKey);
    const last = state?.last_alert_at ?? null;
    if (last && Date.now() - last.getTime() < cooldownMin * 60_000) {
      return false; // dentro da janela -> suprime
    }
    await alerts.upsertState({
      checkKey,
      state: 'up',
      lastAlertAt: new Date(),
      alertCount: (state?.alert_count ?? 0) + 1,
    });
    return true;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'client-alert: cooldown check falhou — fail-open (envia mesmo assim)',
    );
    return true;
  }
}

/**
 * Escala o pedido de cancelamento pro dono do clone. NÃO toca GCal. Nunca lança:
 * captura tudo e devolve um resultado tipado (fire-and-forget pro caminho do bot).
 *
 * @param slot              slot do clone (this.slot do bot).
 * @param clienteTelefone   telefone do cliente final (só p/ phone_hint + cooldown key).
 * @param motivo            motivo informado pelo cliente (pode ser vazio).
 * @param referenciaHorario dia/horário que o cliente citou (pode ser vazio).
 */
export async function sendClientCancellationAlert(input: {
  slot: string;
  clienteTelefone: string;
  motivo: string;
  referenciaHorario: string;
}): Promise<ClientAlertResult> {
  const { slot, clienteTelefone, motivo, referenciaHorario } = input;
  try {
    const owner = await flowClones.getCloneAlertOwner(slot);
    if (!owner || !owner.enabled) {
      log.info({ slot, reason: 'disabled' }, 'client-alert: escalonamento desabilitado p/ clone');
      return { ok: true, escalado: false, reason: 'disabled' };
    }
    if (!owner.phone) {
      log.warn({ slot }, 'client-alert: clone sem alert_owner_phone — não há destino');
      return { ok: true, escalado: false, reason: 'no_owner' };
    }

    // Anti-flood por (slot, telefone do cliente).
    const allowed = await reserveCooldown(
      cooldownKey(slot, clienteTelefone),
      config.CANCELAMENTO_ESCALADO_COOLDOWN_MIN,
    );
    if (!allowed) {
      log.info(
        { slot, clientHint: phoneHint(clienteTelefone) },
        'client-alert: dentro do cooldown — alerta suprimido (anti-flood)',
      );
      return { ok: true, escalado: false, reason: 'cooldown' };
    }

    // Resolve a sessão remetente (sender_slot -> bot_config.waha_sessao, hoje `ALERTAS`).
    const cfg = await alerts.getConfig();
    const sessao = await alerts.getSenderSession(cfg.sender_slot);
    if (!sessao) {
      log.error(
        { slot, senderSlot: cfg.sender_slot },
        'client-alert: sender_slot sem waha_sessao — alerta não enviado (degrada gracioso)',
      );
      return { ok: false, escalado: false, reason: 'send_failed' };
    }

    const texto = buildOwnerMessage({
      cloneDisplayName: owner.displayName,
      clientePhoneHint: phoneHint(clienteTelefone),
      referenciaHorario,
      motivo,
    });

    await Promise.race([
      waha.sendText({ sessao, chatId: toChatId(owner.phone), texto, typing: false, delayMs: 0 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sendText timeout')), SEND_TIMEOUT_MS),
      ),
    ]);

    // NÃO loga o número do dono nem o do cliente em claro (LGPD) — só hints/slot.
    log.info(
      { slot, sessao, ownerHint: phoneHint(owner.phone), clientHint: phoneHint(clienteTelefone) },
      'client-alert: cancelamento escalado pro dono do clone',
    );
    return { ok: true, escalado: true };
  } catch (e) {
    // Fail-safe absoluto: falha do alerta NUNCA quebra o atendimento.
    log.error(
      { slot, err: e instanceof Error ? e.message : String(e) },
      'client-alert: falha ao escalar cancelamento — atendimento segue normal',
    );
    return { ok: false, escalado: false, reason: 'error' };
  }
}
