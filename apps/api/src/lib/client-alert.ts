/**
 * owner-alert — envio de alerta pro DONO do clone (Missão 023 W5 → generalizado SCRUM-59).
 *
 * Nasceu como escalonamento de CANCELAMENTO (o bot não cancela na agenda: ESCALA um
 * WhatsApp pro dono). SCRUM-59 (modo atendente) GENERALIZOU o mesmo transporte para
 * outros `kind`s (escalonamento humano, lead/interesse), variando SÓ o corpo da mensagem.
 *
 * DESENHO (regras de ouro + design W5, preservados na generalização):
 *  - DORMENTE por flag no CHAMADOR: cada callsite (tool no bot) só chega aqui com a
 *    respectiva feature-flag ON. Este módulo, se chamado, tenta enviar. Toggle fino
 *    por-clone = alert_owner_enabled (comum a todos os kinds).
 *  - LGPD-safe: a mensagem ao dono leva só um phone_hint do cliente (5535****1234),
 *    o nome do clone e os campos que o cliente informou. NUNCA telefone cru em log.
 *    NUNCA persiste o conteúdo da conversa.
 *  - Anti-flood: cooldown por (slot, KIND, hash do telefone do cliente) reusando a
 *    máquina alert_states (sem tabela nova). O `cancelamento` mantém a chave LEGADA
 *    (sem segmento de kind) → cooldown byte-idêntico ao de hoje; kinds novos usam
 *    namespace próprio por kind, então um lead não suprime uma escalação e vice-versa.
 *  - Fire-and-forget / fail-safe: QUALQUER falha (sem destino, sessão caída, timeout,
 *    erro de DB) é capturada e logada — NUNCA propaga pro atendimento. O bot sempre
 *    responde ao cliente, mesmo que o alerta não saia. Retorna o resultado pro log.
 *  - Idempotência de transporte: 1 disparo = 1 mensagem; o cooldown serializa repetições.
 *
 * TRANSPORTE (por que é parâmetro EXPLÍCITO, não derivado do kind):
 *  - `alertas`       -> sessão remetente global (sender_slot → waha_sessao, hoje `ALERTAS`).
 *                       É o transporte do CANCELAMENTO (byte-idêntico ao de hoje).
 *  - `clone_session` -> a PRÓPRIA sessão WAHA do clone (flow_clones.waha_sessao). É o
 *                       transporte da escalação/lead do modo atendente. A ALERTAS está
 *                       muda por `ack 463` (ver [[missao-imagem-waha-463]]); rotear o lead
 *                       pela sessão QUENTE do próprio clone evita o SPOF. O transporte é
 *                       explícito no callsite JUSTAMENTE pra ninguém rotear lead pela
 *                       ALERTAS por engano enquanto durar o bloqueio.
 */
import { createHash } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { isModoAtendenteEnabled } from '@startap/core/modo-atendente-gate';
// Subpath /phone (não a raiz) p/ não arrastar crypto.ts no load. Defesa em profundidade:
// normaliza o DDI do dono antes do chatId — alert_owner_phone pode ter vindo cru.
import { ensureDddBr } from '@startap/core/phone';
// Taxonomia de falha de envio (fonte única no core; reusada pelo worker) — decide se um envio
// falho é DEFINITIVO (rollback seguro do cooldown) ou AMBÍGUO (mantém, anti-duplicata). Lição #412.
import { isDefinitiveNonDelivery } from '@startap/core/waha-send-failure';
import { alerts, flowClones } from '@startap/db';
import { waha } from '@startap/integrations';
import { config } from '../config.js';
// SCRUM-62: marca do eco do alerta (mesma máquina do base.ts). Ver nota no envio.
import { registerBotReplyEcho } from './human-reply-pause.js';

const log = logger.child({ module: 'client-alert' });

/** Timeout duro do sendText — o caminho do bot nunca espera WAHA indefinidamente.
 *  Embrulha o sendText INTEIRO, incluindo o delay humanizador (cabe com folga:
 *  1.5s << 8s). */
const SEND_TIMEOUT_MS = 8000;

/** Humanização do envio — "digitando…" + delay antes de enviar, p/ reduzir risco
 *  de o padrão de bot derrubar a sessão remetente. 1 destinatário só (o dono do
 *  clone) → não há pausa de loop, só typing + delay. */
const ALERT_TYPING_DELAY_MS = 1_500;

export type ClientAlertResult =
  | { ok: true; escalado: true }
  | { ok: true; escalado: false; reason: 'disabled' | 'no_owner' | 'cooldown' }
  | { ok: false; escalado: false; reason: 'send_failed' | 'error' };

/** Alias semântico do resultado (mesma forma) para os callsites novos. */
export type OwnerAlertResult = ClientAlertResult;

/** Categoria do alerta ao dono — só muda o CORPO da mensagem (buildOwnerMessage). */
export type OwnerAlertKind = 'cancelamento' | 'escalonamento' | 'lead';

/** Como o alerta chega ao dono. Ver nota de cabeçalho (por que é explícito). */
export type OwnerAlertTransport = 'alertas' | 'clone_session';

/** Payload do kind `cancelamento` (comportamento legado). */
export interface CancelamentoPayload {
  motivo: string;
  referenciaHorario: string;
}

/** Payload do kind `escalonamento` (modo atendente — passa a bola pro humano). */
export interface EscalonamentoPayload {
  /** reclamacao | negociacao | fora_do_padrao | pediu_humano (livre; validado no callsite). */
  motivo: string;
  /** 1-2 frases do que o cliente quer, pra equipe entrar já situada. */
  resumo: string;
}

/** Payload do kind `lead` (modo atendente — interesse em agendar coletado). */
export interface LeadPayload {
  /** Nome do cliente (já conhecido pela conversa). Opcional. */
  nome?: string;
  /** Serviço desejado, como o cliente falou. */
  servico: string;
  /** Preferência de profissional; '' se tanto faz / negócio individual. */
  profissional?: string;
  /** Melhor dia/faixa, ex.: "sábado de manhã". */
  janela: string;
  /** Algo relevante ("cliente novo", "veio do instagram"). Opcional. */
  observacao?: string;
}

export type OwnerAlertInput =
  | {
      slot: string;
      clienteTelefone: string;
      transport: OwnerAlertTransport;
      kind: 'cancelamento';
      payload: CancelamentoPayload;
    }
  | {
      slot: string;
      clienteTelefone: string;
      transport: OwnerAlertTransport;
      kind: 'escalonamento';
      payload: EscalonamentoPayload;
    }
  | {
      slot: string;
      clienteTelefone: string;
      transport: OwnerAlertTransport;
      kind: 'lead';
      payload: LeadPayload;
    };

/** Mascara telefone para log/mensagem (LGPD): 5535999991234 -> 5535****1234. */
export function phoneHint(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 8) return '***';
  return `${d.slice(0, 4)}****${d.slice(-4)}`;
}

/**
 * Telefone EM CLARO, formatado legível pro DONO ligar de volta (decisão Bruno 03/07).
 * USO RESTRITO: só no CORPO da mensagem de WhatsApp ao dono (controlador que precisa do
 * contato) nos kinds lead/escalonamento — NUNCA em LOG (log usa sempre phoneHint). BR E.164
 * (55 + DDD + 8/9 dígitos) -> "(19) 98101-8908"; fora do padrão -> devolve os dígitos crus.
 */
export function phoneDisplay(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return d || '(número indisponível)';
}

/**
 * check_key do cooldown: por slot + KIND + hash curto do telefone do cliente (sem PII na
 * chave). O `cancelamento` mantém a chave LEGADA (sem kind) → cooldown byte-idêntico ao de
 * hoje (nenhum estado órfão no deploy). Kinds novos namespaceiam por kind (isolados entre si).
 */
function cooldownKey(slot: string, kind: OwnerAlertKind, clienteTelefone: string): string {
  const h = createHash('sha256')
    .update(clienteTelefone.replace(/\D/g, ''))
    .digest('hex')
    .slice(0, 12);
  return kind === 'cancelamento' ? `clientalert:${slot}:${h}` : `clientalert:${slot}:${kind}:${h}`;
}

/** Normaliza E.164 (só dígitos) -> chatId WhatsApp. */
function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

/**
 * Monta a mensagem pro dono. Só o CORPO varia por kind. Telefone do cliente:
 *  - `cancelamento` -> MASCARADO (phoneHint), byte-idêntico ao de hoje;
 *  - `escalonamento`/`lead` -> EM CLARO (phoneDisplay), pra o dono ligar de volta
 *    (decisão Bruno 03/07). O dono é o controlador e já tem relação com o contato.
 * LOG segue SEMPRE mascarado (o clear é só aqui, no corpo do WhatsApp ao dono).
 */
function buildOwnerMessage(input: {
  kind: OwnerAlertKind;
  cloneDisplayName: string;
  clienteTelefone: string;
  payload: CancelamentoPayload | EscalonamentoPayload | LeadPayload;
}): string {
  const { kind, cloneDisplayName, clienteTelefone } = input;

  if (kind === 'cancelamento') {
    // BYTE-IDÊNTICO ao de hoje (Cirilo/Samuel) — telefone MASCARADO. NÃO alterar.
    const p = input.payload as CancelamentoPayload;
    const ref = p.referenciaHorario.trim() || 'não especificado';
    const motivo = p.motivo.trim();
    const linhas = [
      `Pedido de CANCELAMENTO no ${cloneDisplayName}.`,
      `Cliente: ${phoneHint(clienteTelefone)}`,
      `Horário citado: ${ref}`,
    ];
    if (motivo) linhas.push(`Motivo: ${motivo}`);
    linhas.push('Entre em contato com o cliente para resolver. (O bot NÃO cancelou nada.)');
    return linhas.join('\n');
  }

  if (kind === 'escalonamento') {
    const p = input.payload as EscalonamentoPayload;
    const motivo = p.motivo.trim() || 'não especificado';
    const resumo = p.resumo.trim();
    const linhas = [
      `Atendimento ESCALADO no ${cloneDisplayName}.`,
      // EM CLARO: o dono precisa do número pra assumir o atendimento.
      `📱 Telefone: ${phoneDisplay(clienteTelefone)}`,
      `Motivo: ${motivo}`,
    ];
    if (resumo) linhas.push(`Resumo: ${resumo}`);
    linhas.push('O cliente pediu (ou precisa de) atendimento humano. Assuma a conversa.');
    return linhas.join('\n');
  }

  // kind === 'lead'
  const p = input.payload as LeadPayload;
  const nome = (p.nome ?? '').trim();
  const servico = p.servico.trim() || 'não especificado';
  const profissional = (p.profissional ?? '').trim();
  const janela = p.janela.trim() || 'não especificado';
  const observacao = (p.observacao ?? '').trim();
  const linhas = [
    `Novo INTERESSE em agendar no ${cloneDisplayName}.`,
    // EM CLARO: o dono precisa do número pra confirmar o horário com o cliente.
    `📱 Telefone: ${phoneDisplay(clienteTelefone)}`,
  ];
  if (nome) linhas.push(`Nome: ${nome}`);
  linhas.push(`Serviço: ${servico}`);
  if (profissional) linhas.push(`Profissional: ${profissional}`);
  linhas.push(`Melhor horário: ${janela}`);
  if (observacao) linhas.push(`Obs: ${observacao}`);
  linhas.push('Confirme o horário com o cliente. (O bot NÃO agendou nada.)');
  return linhas.join('\n');
}

/**
 * Reserva do cooldown anti-flood. `allowed:false` = dentro da janela (suprime). `allowed:true` =
 * pode enviar; carimba o estado ANTES do envio (lock otimista anti-duplicata). Devolve o que
 * carimbou (reservedAt/reservedCount) + o estado ANTERIOR (prevAlertAt/prevCount) pra permitir o
 * ROLLBACK CAS quando o envio comprovadamente NÃO sai (lição #412). Fail-open: erro de DB NÃO
 * bloqueia o envio — nesse caso reservedAt=null (nada foi carimbado de forma confiável → sem revert).
 */
type CooldownReservation =
  | { allowed: false }
  | {
      allowed: true;
      /** timestamp carimbado; null = fail-open (nada a reverter). */
      reservedAt: Date | null;
      reservedCount: number;
      prevAlertAt: Date | null;
      prevCount: number;
    };

async function reserveCooldown(
  checkKey: string,
  cooldownMin: number,
): Promise<CooldownReservation> {
  try {
    const state = await alerts.getState(checkKey);
    const last = state?.last_alert_at ?? null;
    if (last && Date.now() - last.getTime() < cooldownMin * 60_000) {
      return { allowed: false }; // dentro da janela -> suprime
    }
    const prevCount = state?.alert_count ?? 0;
    const reservedAt = new Date();
    const reservedCount = prevCount + 1;
    await alerts.upsertState({
      checkKey,
      state: 'up',
      lastAlertAt: reservedAt,
      alertCount: reservedCount,
    });
    return { allowed: true, reservedAt, reservedCount, prevAlertAt: last, prevCount };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'client-alert: cooldown check falhou — fail-open (envia mesmo assim)',
    );
    // Fail-open: nada carimbado de forma confiável -> reservedAt=null (sem reserva a reverter).
    return { allowed: true, reservedAt: null, reservedCount: 0, prevAlertAt: null, prevCount: 0 };
  }
}

/**
 * Rollback do carimbo de cooldown quando o envio FALHA DEFINITIVO (não saiu): restaura o estado
 * ANTERIOR pra que o próximo retry ENVIE (em vez de ser suprimido como anti-flood). CAS (#412):
 * só reverte se a linha ainda contém EXATAMENTE o que ESTE envio carimbou — não pisa numa reserva
 * mais nova de outro fluxo. Best-effort: falha do revert NUNCA propaga (o pior caso vira só 1
 * alerta suprimido, não um crash no caminho do bot).
 */
async function revertCooldownReservation(
  checkKey: string,
  reservation: {
    reservedAt: Date;
    reservedCount: number;
    prevAlertAt: Date | null;
    prevCount: number;
  },
): Promise<void> {
  try {
    await alerts.restoreStateIfUnchanged({
      checkKey,
      expect: {
        state: 'up',
        lastAlertAt: reservation.reservedAt,
        alertCount: reservation.reservedCount,
      },
      restore: {
        state: 'up',
        downSince: null,
        lastAlertAt: reservation.prevAlertAt,
        alertCount: reservation.prevCount,
        pendingDownCount: 0,
      },
    });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'owner-alert: revert do cooldown falhou (best-effort)',
    );
  }
}

/**
 * Resolve a sessão WAHA remetente conforme o transporte.
 *  - 'alertas'       -> sender_slot (alert_config) → waha_sessao (hoje `ALERTAS`).
 *  - 'clone_session' -> a própria sessão do clone (flow_clones.waha_sessao).
 * Retorna null se não houver sessão (degrada gracioso — o chamador vira send_failed).
 */
async function resolveTransportSession(
  transport: OwnerAlertTransport,
  slot: string,
): Promise<string | null> {
  if (transport === 'clone_session') {
    const clone = await flowClones.getCloneBySlot(slot);
    return clone?.waha_sessao ?? null;
  }
  const cfg = await alerts.getConfig();
  return alerts.getSenderSession(cfg.sender_slot);
}

/**
 * Escala um alerta pro DONO do clone (não toca GCal). Nunca lança: captura tudo e devolve
 * um resultado tipado (fire-and-forget pro caminho do bot). Comum a todos os kinds — só o
 * corpo da mensagem (buildOwnerMessage) e o transporte variam.
 *
 * @param slot            slot do clone (this.slot do bot).
 * @param clienteTelefone telefone do cliente final (só p/ phone_hint + cooldown key).
 * @param kind            cancelamento | escalonamento | lead (varia o corpo).
 * @param transport       alertas | clone_session (ver nota de cabeçalho).
 * @param payload         campos do kind.
 */
export async function sendOwnerAlert(input: OwnerAlertInput): Promise<OwnerAlertResult> {
  const { slot, clienteTelefone, kind, transport } = input;
  try {
    const owner = await flowClones.getCloneAlertOwner(slot);
    if (!owner || !owner.enabled) {
      log.info({ slot, kind, reason: 'disabled' }, 'owner-alert: alerta desabilitado p/ clone');
      return { ok: true, escalado: false, reason: 'disabled' };
    }
    if (!owner.phone) {
      log.warn({ slot, kind }, 'owner-alert: clone sem alert_owner_phone — não há destino');
      return { ok: true, escalado: false, reason: 'no_owner' };
    }
    // Defesa em profundidade: garante o DDI 55 do dono (conservador, NÃO toca no 9)
    // antes de virar chatId. Se o número for irrecuperável (lixo/ambíguo), NÃO envia
    // pra destino inválido — degrada gracioso (LGPD: só hint no log, nunca o número).
    const ownerPhone = ensureDddBr(owner.phone);
    if (!ownerPhone) {
      log.warn(
        { slot, kind, ownerHint: phoneHint(owner.phone) },
        'owner-alert: alert_owner_phone não normalizável (DDI/DDD inválido) — alerta não enviado',
      );
      return { ok: true, escalado: false, reason: 'no_owner' };
    }

    // Anti-flood por (slot, kind, telefone do cliente).
    const cdKey = cooldownKey(slot, kind, clienteTelefone);
    const reservation = await reserveCooldown(cdKey, config.CANCELAMENTO_ESCALADO_COOLDOWN_MIN);
    if (!reservation.allowed) {
      log.info(
        { slot, kind, clientHint: phoneHint(clienteTelefone) },
        'owner-alert: dentro do cooldown — alerta suprimido (anti-flood)',
      );
      return { ok: true, escalado: false, reason: 'cooldown' };
    }

    const sessao = await resolveTransportSession(transport, slot);
    if (!sessao) {
      // Sem sessão remetente = definitivamente NÃO saiu -> reverte o carimbo pra o próximo
      // retry ENVIAR (não suprimir como anti-flood). Mesma classe do #412.
      if (reservation.reservedAt) {
        await revertCooldownReservation(cdKey, {
          reservedAt: reservation.reservedAt,
          reservedCount: reservation.reservedCount,
          prevAlertAt: reservation.prevAlertAt,
          prevCount: reservation.prevCount,
        });
      }
      log.error(
        { slot, kind, transport },
        'owner-alert: sem sessão remetente — alerta não enviado (cooldown revertido)',
      );
      return { ok: false, escalado: false, reason: 'send_failed' };
    }

    const texto = buildOwnerMessage({
      kind,
      cloneDisplayName: owner.displayName,
      // Telefone CRU: buildOwnerMessage decide mascarar (cancelamento) ou clear (lead/escalonamento).
      clienteTelefone,
      payload: input.payload,
    });

    // SCRUM-62 (cinto+suspensório): quando o alerta sai pela PRÓPRIA sessão do clone
    // (transport clone_session, modo atendente) e o destino (alert_owner_phone) é um número
    // DIFERENTE da sessão, o self-chat guard do router NÃO barra o eco fromMe desta mensagem.
    // Sem a marca, esse eco viraria 'resposta humana' e pausaria o CONTATO DO DONO por 60min
    // (suspeita real: pausa human_reply do ...8908 em 06/07). Marca o texto ANTES do envio
    // (mesma razão de ordem do base.ts): best-effort, nunca lança. Gated pelo modo atendente.
    if (
      transport === 'clone_session' &&
      isModoAtendenteEnabled(slot, config.MODO_ATENDENTE_SLOTS)
    ) {
      await registerBotReplyEcho(sessao, ownerPhone, texto);
    }

    try {
      await Promise.race([
        waha.sendText({
          sessao,
          chatId: toChatId(ownerPhone),
          texto,
          typing: true,
          delayMs: ALERT_TYPING_DELAY_MS,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('sendText timeout')), SEND_TIMEOUT_MS),
        ),
      ]);
    } catch (sendErr) {
      // ROLLBACK do cooldown SÓ em falha DEFINITIVA (404/422/ECONNREFUSED): o carimbo "avisado"
      // foi feito ANTES do envio; se o envio comprovadamente NÃO saiu, desfaz pra o retry seguinte
      // ENVIAR (bug provado no piloto: sendText 422 com a sessão FAILED deixava o carimbo → todos
      // os retests do lead viravam 'dentro do cooldown'). Ambíguo (timeout/5xx) MANTÉM o carimbo
      // (anti-duplicata a pagante, lição #412). CAS: só o dono da reserva desfaz.
      if (isDefinitiveNonDelivery(sendErr) && reservation.reservedAt) {
        await revertCooldownReservation(cdKey, {
          reservedAt: reservation.reservedAt,
          reservedCount: reservation.reservedCount,
          prevAlertAt: reservation.prevAlertAt,
          prevCount: reservation.prevCount,
        });
        log.warn(
          {
            slot,
            kind,
            transport,
            err: sendErr instanceof Error ? sendErr.message : String(sendErr),
          },
          'owner-alert: envio falhou (definitivo) — cooldown revertido p/ o próximo retry enviar',
        );
      }
      throw sendErr; // outer catch -> {ok:false, reason:'error'} (mantém carimbo se ambíguo)
    }

    // NÃO loga o número do dono nem o do cliente em claro (LGPD) — só hints/slot.
    log.info(
      {
        slot,
        kind,
        transport,
        sessao,
        ownerHint: phoneHint(owner.phone),
        clientHint: phoneHint(clienteTelefone),
      },
      'owner-alert: alerta escalado pro dono do clone',
    );
    return { ok: true, escalado: true };
  } catch (e) {
    // Fail-safe absoluto: falha do alerta NUNCA quebra o atendimento.
    log.error(
      { slot, kind, err: e instanceof Error ? e.message : String(e) },
      'owner-alert: falha ao escalar — atendimento segue normal',
    );
    return { ok: false, escalado: false, reason: 'error' };
  }
}

/**
 * Wrapper FINO do cancelamento (Missão 023 W5) — comportamento BYTE-IDÊNTICO ao de hoje
 * (Cirilo/Samuel). Kind='cancelamento', transporte='alertas' (sessão ALERTAS), cooldown na
 * chave legada. Mantido pra não tocar os callsites do bot que já escalam cancelamento.
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
  return sendOwnerAlert({
    slot: input.slot,
    clienteTelefone: input.clienteTelefone,
    kind: 'cancelamento',
    transport: 'alertas',
    payload: { motivo: input.motivo, referenciaHorario: input.referenciaHorario },
  });
}
