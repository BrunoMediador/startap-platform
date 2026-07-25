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

/** Timeout por envio — sendText (client.ts) não tem timeout próprio. Embrulha o
 *  sendText INTEIRO, incluindo o delay humanizador (ALERT_TYPING_DELAY_MS), que
 *  cabe com folga aqui (1.5s << 10s). */
const SEND_TIMEOUT_MS = 10_000;

/** Humanização do envio de alerta — reduz risco de derrubar a sessão remetente
 *  (ALERTAS) por padrão de bot. Mostra "digitando…" antes e espaça os envios em
 *  vez de rajada colada. Valores conservadores p/ WhatsApp parecer humano sem
 *  atrasar demais o alerta:
 *   - DELAY: pausa "digitando" antes de cada mensagem sair;
 *   - BETWEEN_RECIPIENTS: pausa ENTRE um destinatário e o próximo (anti-rajada).
 *  Mantemos SEQUENCIAL (nunca Promise.all) — paralelizar é justamente o padrão
 *  que estressa a sessão. */
const ALERT_TYPING_DELAY_MS = 1_500;
const ALERT_BETWEEN_RECIPIENTS_MS = 1_200;

/** Pausa não-bloqueante (humanização do envio). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

    // (5) Envia a cada destinatário, SEQUENCIAL e espaçado (anti-rajada — não
    //     paralelizar). Mostra "digitando…" + delay humanizador antes de cada
    //     envio; pausa ENTRE destinatários. Falha individual não derruba os demais.
    let sent = 0;
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      try {
        await Promise.race([
          sendText({
            sessao,
            chatId: toChatId(r.phone),
            texto,
            typing: true,
            delayMs: ALERT_TYPING_DELAY_MS,
          }),
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
      // Pausa antes do próximo destinatário (não depois do último).
      if (i < recipients.length - 1) await sleep(ALERT_BETWEEN_RECIPIENTS_MS);
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

/**
 * G — signup provisionou o clone mas a sessão WAHA NÃO subiu (auditoria 13/07): o
 * createWahaSession falhou e o clone ficou em 'rascunho' com waha_sessao NULL
 * ("aguardando reparo"). O cliente destrava sozinho ao clicar reconectar no portal
 * (reparo on-demand cria a sessão na hora) — este alerta é só visibilidade pro
 * time acompanhar/agir se o reparo também falhar. LGPD-safe (sem telefone/CPF).
 */
export function msgSignupWahaFalha(input: { nomeNegocio: string; slot: string }): string {
  return `🟠 Signup com WAHA falho: "${input.nomeNegocio}" — clone ${input.slot} provisionado, mas a sessão WAHA NÃO subiu (aguardando reparo). O cliente destrava ao reconectar no portal.`;
}

/** B — cliente pareou o WhatsApp e iniciou o trial. */
export function msgClienteAtivou(input: { displayName: string; slot: string }): string {
  return (
    `✅ Cliente ativou: "${input.displayName}" pareou o WhatsApp e ` +
    `começou o trial — slot ${input.slot}.`
  );
}

/**
 * D — cliente escolheu AGENDA no signup e o time precisa conectar a Service Account
 * do Google (etapa manual, ADR 0024 / ADR 0030 D3). Enquanto não conecta, o bot opera
 * em degrade (atendente). LGPD-safe (sem telefone/CPF). SLA operacional = 24h úteis.
 */
export function msgAguardandoAgenda(input: {
  nomeNegocio: string;
  slot: string;
  formato: 'individual' | 'estabelecimento';
}): string {
  const tipo =
    input.formato === 'estabelecimento' ? 'estabelecimento (agenda por colaborador)' : 'individual';
  const detalhe = 'Enquanto a Service Account não for conectada, o bot atende como recepção';
  return (
    `📅 Conectar agenda do Google: "${input.nomeNegocio}" (${tipo}) escolheu AGENDA no ` +
    `cadastro — slot ${input.slot}. ${detalhe} (sem marcar). SLA: até 24h úteis.`
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

/**
 * F — ENTREGA falhando numa sessão (SCRUM-58): N outbounds receberam nack TERMINAL (ack -1/463) ou
 * ficaram PRESOS sem confirmação de entrega. Agregado por SESSÃO (1 alerta cobre N mensagens) —
 * evita flood quando a sessão inteira fica muda. LGPD-safe: só nome da sessão/negócio + slot +
 * contagens + UM telefone-hint JÁ mascarado (nunca número em claro/CPF, nunca conteúdo).
 */
export function msgOutboundNaoEntregue(input: {
  session: string;
  displayName: string;
  slot: string | null;
  /** total de outbounds alertáveis nesta sessão neste ciclo. */
  total: number;
  /** quantos são nack TERMINAL (ack -1 / 463). */
  nackTerminal: number;
  /** quantos estão PRESOS sem entrega (PENDING/SERVER além do timeout). */
  presos: number;
  /** telefone-hint JÁ mascarado de um exemplo (LGPD). */
  sampleHint: string;
  /** status do exemplo (ERROR/PENDING/SERVER). */
  sampleStatus: string;
}): string {
  const alvo = input.slot
    ? `sessão ${input.session} (clone ${input.slot} — "${input.displayName}")`
    : `sessão ${input.session} ("${input.displayName}")`;
  const detalhe = `${input.nackTerminal} nack/463, ${input.presos} presa(s) sem ack`;
  return (
    `🔴 Entrega falhando: ${alvo} — ${input.total} mensagem(ns) do bot sem confirmação de entrega ` +
    `(${detalhe}). Ex.: destino …${input.sampleHint} em ${input.sampleStatus}. Verificar a sessão/número.`
  );
}

/**
 * E — bot de um clone PAGANTE silenciado pelo gate de inadimplência (SCRUM-67). Visibilidade
 * pro time agir (reconciliar pagamento OU confirmar churn) — o gate/silêncio NÃO é tocado.
 * LGPD-safe: SEM telefone em claro/CPF (só nome do negócio + slot + data de vencimento + dias).
 */
export function msgBotSilenciadoInadimplencia(input: {
  displayName: string;
  slot: string;
  /** Vencimento 'YYYY-MM-DD'. */
  nextDueDate: string;
  /** Dias de atraso (positivo). */
  diasAtraso: number;
}): string {
  const dias = Math.max(0, Math.trunc(input.diasAtraso));
  const plural = dias === 1 ? 'dia' : 'dias';
  const acao = 'Reconciliar o pagamento ou confirmar churn.';
  return (
    `⚠️ Bot silenciado por atraso: "${input.displayName}" (slot ${input.slot}) está MUDO por ` +
    `inadimplência — venceu em ${input.nextDueDate} (${dias} ${plural} de atraso). ${acao}`
  );
}

/**
 * H — TRIAL prestes a expirar com o bot DESLIGADO pelo próprio dono (SCRUM-125). Churn silencioso:
 * o dono pausou pelo portal (owner_request) e não religou, e o trial vai vencer sem conversão. O time
 * precisa falar com o cliente ANTES. ⚠️ PIX NÃO religa owner_request — pagar não basta. Visibilidade
 * pura (não toca o bot/pausa). LGPD-safe: SEM telefone em claro/CPF (só nome do negócio + slot + data
 * + dias). Cobre "já venceu" (diasAteVencer <= 0) com copy adequada.
 */
export function msgTrialOwnerPausado(input: {
  displayName: string;
  slot: string;
  /** Vencimento do trial 'YYYY-MM-DD'. */
  nextDueDate: string;
  /** Dias até o trial vencer (negativo/0 = já venceu). */
  diasAteVencer: number;
  /** Dias que o dono está com o bot pausado (positivo). */
  diasPausado: number;
}): string {
  const pausa = Math.max(0, Math.trunc(input.diasPausado));
  const pPlural = pausa === 1 ? 'dia' : 'dias';
  const venc =
    input.diasAteVencer <= 0
      ? `o trial JÁ venceu (${input.nextDueDate})`
      : `o trial vence em ${input.nextDueDate} (${input.diasAteVencer} dia(s))`;
  const acao =
    'Falar com o cliente antes de virar churn silencioso. ⚠️ PIX NÃO religa pausa do dono.';
  return (
    `🟠 Trial em risco de churn: "${input.displayName}" (slot ${input.slot}) — o DONO desligou o bot ` +
    `há ${pausa} ${pPlural} e ${venc}. ${acao}`
  );
}
