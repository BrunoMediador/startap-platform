/**
 * client-disconnect-notify — auto-aviso de DESCONEXÃO ao próprio cliente (B2B).
 *
 * Chamado pelo job monitor (Missão 021) EXATAMENTE na transição up->down CONFIRMADA de um
 * check waha:<sessao> que pertence a um CLONE (slot != null). Ou seja: a sessão de um cliente
 * que JÁ tinha conectado acabou de cair. Além do alerta interno pro Bruno (que o monitor já
 * dispara), manda 1 WhatsApp pro DONO do clone avisando + como reconectar sozinho no portal.
 *
 * REUSA o transporte do cancelamento escalado (W5): sessão remetente ALERTAS (sender_slot ->
 * bot_config.waha_sessao) + destino flow_clones.alert_owner_phone (fallback cliente_telefone).
 * A COPY (editável pelo Bruno) e o render vivem em @startap/core/client-disconnect-alert.
 *
 * DESENHO (regras de ouro + brief):
 *  - GATE MACRO: CLIENT_DISCONNECT_ALERT_ENABLED (default OFF). Checado pelo CHAMADOR (monitor)
 *    ANTES de chamar — com OFF este módulo nem é invocado. Defesa em profundidade: se chamado, a
 *    flag também é relida aqui? Não: o gate é do monitor (1 leitura de config), este módulo é o
 *    transporte. O monitor só chama quando a flag está ON.
 *  - OPT-IN POR-CLONE: só envia se alert_owner_enabled=true E destino presente (target.phone).
 *  - ANTI-FLAP + IDEMPOTÊNCIA: a transição up->down já é única por episódio (debounce ~4 min +
 *    máquina de estado do monitor). Além disso, um COOLDOWN por slot (reusando alert_states, igual
 *    ao client-alert do cancelamento) garante no máx 1 msg por janela mesmo num flap rápido; só
 *    re-avisa se reconectar e cair de novo (novo up->down após a janela). check_key dedicado:
 *    'clientdown:<slot>'.
 *  - ANTI-PRÉ-SETUP: garantido A MONTANTE — listMonitoredSessions só vigia clones com
 *    first_connected_at != null (já pareados). Clone nunca-conectado jamais gera up->down ->
 *    este módulo nunca é chamado pra ele.
 *  - LGPD: telefone SEMPRE mascarado no log (phoneHint). Conteúdo da msg não é persistido.
 *  - FAIL-SAFE: nunca lança. Qualquer falha (sem destino, sessão caída, timeout, DB) é capturada
 *    e logada; retorna resultado tipado. NUNCA derruba o job monitor nem afeta outros clientes.
 *  - TIMEOUT EXPLÍCITO no sendText (regra 7).
 */
import { createHash } from 'node:crypto';
import { renderClientDisconnectMessage } from '@startap/core/client-disconnect-alert';
import { logger } from '@startap/core/logger';
import { ensureDddBr } from '@startap/core/phone';
import { alerts, flowClones } from '@startap/db';
import { waha } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ module: 'client-disconnect-notify' });

export type ClientDisconnectNotifyResult =
  | { ok: true; sent: true }
  | { ok: true; sent: false; reason: 'opt_out' | 'no_target' | 'cooldown' }
  | { ok: false; sent: false; reason: 'no_sender' | 'send_failed' | 'error' };

/** Mascara telefone para log (LGPD): 5535999991234 -> 5535****1234. */
export function phoneHint(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 8) return '***';
  return `${d.slice(0, 4)}****${d.slice(-4)}`;
}

/** check_key do cooldown anti-flap por clone. Sem PII (usa o slot, não o telefone). */
export function disconnectCooldownKey(slot: string): string {
  return `clientdown:${slot}`;
}

/** Normaliza E.164 (só dígitos) -> chatId WhatsApp. */
function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

/** Chave de log estável da sessão (não loga a sessão crua — basta um hash curto). */
function sessionKey(sessao: string): string {
  return createHash('sha256').update(sessao).digest('hex').slice(0, 8);
}

/**
 * Verifica + reserva o cooldown anti-flap por slot. Retorna true se PODE avisar (e marca o envio),
 * false se ainda está na janela. Reusa a máquina alert_states (sem tabela nova). DIFERENTE do
 * client-alert de cancelamento: aqui, em FALHA de DB no check, fail-CLOSED (return false) — pra
 * uma sessão que flapa, preferimos NÃO avisar a arriscar spam ao cliente se o estado não puder
 * ser lido/gravado. (O alerta interno pro Bruno já cobre a visibilidade do incidente.)
 */
async function reserveCooldown(slot: string, cooldownMin: number): Promise<boolean> {
  const checkKey = disconnectCooldownKey(slot);
  try {
    const state = await alerts.getState(checkKey);
    const last = state?.last_alert_at ?? null;
    if (last && Date.now() - last.getTime() < cooldownMin * 60_000) {
      return false; // dentro da janela -> suprime (anti-flap)
    }
    await alerts.upsertState({
      checkKey,
      state: 'down', // semântica local: "este clone está em episódio de queda já avisado"
      lastAlertAt: new Date(),
      alertCount: (state?.alert_count ?? 0) + 1,
    });
    return true;
  } catch (e) {
    // Fail-CLOSED: sem poder serializar, não arrisca spam ao cliente. Loga e suprime.
    log.warn(
      { slot, err: e instanceof Error ? e.message : String(e) },
      'client-disconnect-notify: cooldown check falhou — fail-closed (NÃO avisa neste ciclo)',
    );
    return false;
  }
}

/**
 * Avisa o DONO do clone que a sessão dele caiu. NÃO toca a sessão do clone (envia pela ALERTAS).
 * Nunca lança: captura tudo e devolve resultado tipado (fire-and-forget pro job monitor).
 *
 * Pré-condição (responsabilidade do chamador): CLIENT_DISCONNECT_ALERT_ENABLED=true E este é um
 * up->down CONFIRMADO de um check de CLONE (slot != null).
 *
 * @param slot slot do clone cuja sessão caiu (âncora do tenant).
 */
export async function notifyClientDisconnect(slot: string): Promise<ClientDisconnectNotifyResult> {
  try {
    const target = await flowClones.getCloneDisconnectAlertTarget(slot);
    if (!target) {
      // slot não é um clone (não deveria ocorrer — o monitor só passa slots de clone). Defensivo.
      log.warn({ slot }, 'client-disconnect-notify: slot sem clone — ignorado');
      return { ok: true, sent: false, reason: 'no_target' };
    }
    if (!target.enabled) {
      log.info({ slot }, 'client-disconnect-notify: opt-out por-clone (alert_owner_enabled=false)');
      return { ok: true, sent: false, reason: 'opt_out' };
    }
    if (!target.phone) {
      log.warn({ slot }, 'client-disconnect-notify: clone sem destino (alert_owner_phone vazio)');
      return { ok: true, sent: false, reason: 'no_target' };
    }
    // Defesa em profundidade: garante DDI/DDD br antes do chatId. Número irrecuperável -> não envia.
    const ownerPhone = ensureDddBr(target.phone);
    if (!ownerPhone) {
      log.warn(
        { slot, ownerHint: phoneHint(target.phone) },
        'client-disconnect-notify: destino não normalizável — aviso não enviado',
      );
      return { ok: true, sent: false, reason: 'no_target' };
    }

    // Cooldown anti-flap por slot (1 msg por episódio de queda).
    const allowed = await reserveCooldown(slot, config.CLIENT_DISCONNECT_ALERT_COOLDOWN_MIN);
    if (!allowed) {
      log.info(
        { slot },
        'client-disconnect-notify: dentro do cooldown — aviso suprimido (anti-flap)',
      );
      return { ok: true, sent: false, reason: 'cooldown' };
    }

    // Resolve a sessão remetente (ALERTAS, via sender_slot -> bot_config.waha_sessao).
    const cfg = await alerts.getConfig();
    const sessao = await alerts.getSenderSession(cfg.sender_slot);
    if (!sessao) {
      log.error(
        { slot, senderSlot: cfg.sender_slot },
        'client-disconnect-notify: sender_slot sem waha_sessao — aviso não enviado',
      );
      return { ok: false, sent: false, reason: 'no_sender' };
    }

    const texto = renderClientDisconnectMessage({ nomeNegocio: target.nomeNegocio });

    await Promise.race([
      waha.sendText({
        sessao,
        chatId: toChatId(ownerPhone),
        texto,
        typing: true,
        delayMs: config.CLIENT_DISCONNECT_ALERT_TYPING_DELAY_MS,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('sendText timeout')),
          config.CLIENT_DISCONNECT_ALERT_SEND_TIMEOUT_MS,
        ),
      ),
    ]);

    // NÃO loga o número do dono em claro (LGPD) — só hint + slot + hash da sessão remetente.
    log.info(
      { slot, ownerHint: phoneHint(target.phone), senderHint: sessionKey(sessao) },
      'client-disconnect-notify: aviso de desconexão enviado ao dono do clone',
    );
    return { ok: true, sent: true };
  } catch (e) {
    // Fail-safe absoluto: falha do aviso NUNCA derruba o monitor nem afeta outros clientes.
    log.error(
      { slot, err: e instanceof Error ? e.message : String(e) },
      'client-disconnect-notify: falha ao avisar o dono — monitor segue normal',
    );
    return { ok: false, sent: false, reason: 'error' };
  }
}
