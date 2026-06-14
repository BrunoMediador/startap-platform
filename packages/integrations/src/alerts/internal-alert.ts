/**
 * internal-alert — disparo de alertas INTERNOS de evento de negócio via Lola.
 *
 * Reusa o Sistema de Alertas Interno (Missão 021): mesmos destinatários
 * (alert_recipients), mesmo kill-switch quente (alert_config.enabled) e mesmo
 * remetente (alert_config.sender_slot → bot_config.waha_sessao, default Lola
 * 'startap'/STARTAP_AI_PROD). Diferença pro job `monitor` (apps/worker): aqui o
 * gatilho é um EVENTO de negócio (cliente self-service: cadastrou / pareou /
 * pagou), não uma varredura de saúde — então NÃO há máquina de estado UP/DOWN,
 * só "manda esta mensagem agora pra quem está ligado".
 *
 * PLACEMENT: mora em @startap/integrations (que JÁ depende de @startap/db —
 * google-calendar/scheduling/abacatepay importam db; não há ciclo, db só depende
 * de @startap/core+pg). Assim portal-api, apps/api e o worker — todos importam
 * @startap/integrations — consomem o mesmo helper sem duplicação. O `broadcast`
 * privado do monitor NÃO é refatorado agora (caminho de saúde intacto).
 *
 * GARANTIA-CHAVE (fire-and-forget seguro): sendInternalAlert NUNCA propaga
 * exceção. Se a Lola/WAHA cair, se o banco falhar, se um destinatário der erro —
 * loga e segue, retornando { sent }. O fluxo de negócio que chama (signup 201,
 * webhook 200, pareamento) JAMAIS pode quebrar por causa de um alerta interno.
 *
 * GATING (sem env obrigatória nova — lição #247 de crash-loop no boot):
 *   - alert_config.enabled !== true  → no-op (kill-switch geral do gestão);
 *   - listEnabledRecipients() vazio  → no-op (ninguém pra avisar);
 *   - anti-flood global (reserveGlobalSend) como rede de segurança — eventos de
 *     cliente novo são RAROS, mas o teto compartilhado com o monitor protege o
 *     número da Lola caso algo dispare em rajada.
 *
 * LGPD: o CHAMADOR monta a mensagem — este helper só transporta. Por contrato,
 * o texto NUNCA deve conter telefone em claro/CPF (use phone_hint). O helper
 * jamais loga o conteúdo da mensagem nem o número do destinatário.
 */
import { logger } from '@startap/core/logger';
import { alerts, query } from '@startap/db';
import { sendText } from '../waha/client.js';

const log = logger.child({ module: 'internal-alert' });

/** Default do remetente — slot da Lola (resolve pra STARTAP_AI_PROD). Igual ao monitor. */
const DEFAULT_SENDER_SLOT = 'startap';

/** Teto/janela do anti-flood global (compartilhado com o monitor via __global__).
 *  Defaults locais — NÃO lê env (evita env obrigatória nova em api/portal-api).
 *  Eventos de negócio são raros; isto é só rede de segurança contra rajada. */
const DEFAULT_MAX_PER_WINDOW = 10;
const DEFAULT_WINDOW_MIN = 30;

/** Timeout por envio — sendText (client.ts) não tem timeout próprio. */
const SEND_TIMEOUT_MS = 10_000;

export interface SendInternalAlertOpts {
  /** slot do remetente (default 'startap' = Lola). */
  senderSlot?: string;
  /** Teto de mensagens por janela do anti-flood global. */
  maxPerWindow?: number;
  /** Tamanho da janela do anti-flood, em minutos. */
  windowMin?: number;
}

export interface SendInternalAlertResult {
  /** Quantos destinatários receberam de fato (0 = no-op ou tudo suprimido/falhou). */
  sent: number;
}

/** E.164 (só dígitos) → chatId WhatsApp '<digits>@c.us'. */
function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

/**
 * Dispara `texto` pra todos os destinatários habilitados do Sistema de Alertas,
 * via Lola. FIRE-AND-FORGET SEGURO: nunca lança — qualquer falha é logada e o
 * resultado volta com a contagem efetiva.
 */
export async function sendInternalAlert(
  texto: string,
  opts: SendInternalAlertOpts = {},
): Promise<SendInternalAlertResult> {
  try {
    // (1) Kill-switch geral do gestão (mesmo toggle dos alertas de saúde).
    const config = await alerts.getConfig();
    if (config.enabled !== true) {
      return { sent: 0 };
    }

    // (2) Destinatários habilitados — vazio = ninguém pra avisar.
    const recipients = await alerts.listEnabledRecipients();
    if (recipients.length === 0) {
      return { sent: 0 };
    }

    // (3) Remetente (Lola). sender_slot da config tem precedência; cai pro default.
    const senderSlot = opts.senderSlot ?? config.sender_slot ?? DEFAULT_SENDER_SLOT;
    const sessao = await alerts.getSenderSession(senderSlot);
    if (!sessao) {
      log.error(
        { senderSlot },
        'internal-alert: remetente sem waha_sessao mapeado — alerta não enviado',
      );
      return { sent: 0 };
    }

    // (4) Anti-flood global (rede de segurança, 1 reserva por DISPARO).
    const reservation = await alerts.reserveGlobalSend({
      maxPerWindow: opts.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW,
      windowMin: opts.windowMin ?? DEFAULT_WINDOW_MIN,
    });
    if (!reservation.allowed) {
      log.warn(
        { sentInWindow: reservation.sentInWindow },
        'internal-alert: hard cap global atingido — alerta de evento suprimido (anti-flood)',
      );
      return { sent: 0 };
    }

    // (5) Envia a cada destinatário. Falha individual não derruba os demais.
    let sent = 0;
    for (const r of recipients) {
      try {
        await Promise.race([
          sendText({ sessao, chatId: toChatId(r.phone), texto, typing: false, delayMs: 0 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('sendText timeout')), SEND_TIMEOUT_MS),
          ),
        ]);
        sent += 1;
      } catch (e) {
        // NÃO loga o número (LGPD) — só o id do destinatário e o erro.
        log.error(
          { recipientId: r.id, err: e instanceof Error ? e.message : String(e) },
          'internal-alert: falha ao enviar alerta pela Lola',
        );
      }
    }
    return { sent };
  } catch (e) {
    // Cinto de segurança final: NADA escapa deste helper pro fluxo de negócio.
    log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'internal-alert: erro inesperado — alerta NÃO enviado (fluxo principal segue)',
    );
    return { sent: 0 };
  }
}

/**
 * Nome de exibição do clone pelo slot (pra montar a mensagem dos ganchos B/C, que
 * não têm o display_name à mão). Best-effort: nunca lança; cai pro próprio slot.
 */
export async function displayNameForSlot(slot: string): Promise<string> {
  try {
    const r = await query<{ display_name: string | null }>(
      'SELECT display_name FROM flow_clones WHERE slot = $1',
      [slot],
    );
    const name = r.rows[0]?.display_name;
    return name && name.trim() !== '' ? name : slot;
  } catch (e) {
    log.warn(
      { slot, err: e instanceof Error ? e.message : String(e) },
      'internal-alert: falha ao resolver display_name — usando slot',
    );
    return slot;
  }
}

/** R$ a partir de centavos, formato pt-BR (mesmo padrão de clone-provisioning). */
export function formatBRLFromCents(cents: number | null | undefined): string {
  const c = typeof cents === 'number' && Number.isFinite(cents) ? cents : 0;
  return `R$${(c / 100).toFixed(2).replace('.', ',')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mensagens dos eventos de cliente novo (LGPD-safe — sem telefone em claro/CPF)
// ─────────────────────────────────────────────────────────────────────────────

/** A — cadastro self-service concluído (ainda não pareou nem pagou). */
export function msgNovoCadastro(input: {
  nomeNegocio: string;
  phoneHint: string;
  slot: string;
  amountCents: number;
}): string {
  return (
    `🆕 Novo cadastro self-service: "${input.nomeNegocio}" ` +
    `(tel …${input.phoneHint}) — slot ${input.slot}, ` +
    `plano ${formatBRLFromCents(input.amountCents)}. Ainda não pareou/pagou.`
  );
}

/** B — cliente pareou o WhatsApp e iniciou o trial. */
export function msgClienteAtivou(input: { displayName: string; slot: string }): string {
  return (
    `✅ Cliente ativou: "${input.displayName}" pareou o WhatsApp e ` +
    `começou o trial — slot ${input.slot}.`
  );
}

/** C — PRIMEIRO pagamento (cliente novo virou pagante). NÃO usar em renovação. */
export function msgClientePagou(input: {
  displayName: string;
  slot: string;
  paidAmountCents: number;
}): string {
  return (
    `💰 Cliente NOVO pagou: "${input.displayName}" — ` +
    `${formatBRLFromCents(input.paidAmountCents)} via PIX. slot ${input.slot}.`
  );
}
