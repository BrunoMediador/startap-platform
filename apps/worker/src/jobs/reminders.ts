/**
 * Job — LEMBRETE DE AGENDAMENTO (one-way, configurável por clone). Migration 060.
 *
 * Varre os `atendimentos` de AGENDA (origem='agenda', não deletados, não cancelados) de
 * clones com `reminders_enabled=TRUE` e, para cada JANELA configurada (24h/3h/2h/1h), dispara
 * 1 WhatsApp quando o horário entra no gatilho [janela - tolerância, janela]. Envia pela sessão
 * WAHA do PRÓPRIO clone (flow_clones.waha_sessao). NÃO lê do GCal — a fonte é a tabela.
 *
 * GATE DUPLO: o worker só registra o cron com REMINDERS_ENABLED=true (global, default OFF); E
 * por-clone via flow_clones.reminders_enabled (filtrado no SQL). Com tudo OFF nada é lido/enviado.
 *
 * IDEMPOTÊNCIA (regra de ouro 6): claimReminder faz INSERT no reminder_log com UNIQUE
 * (atendimento_id, window_min, inicio_at). Rodar 2× = 1 envio (o 2º claim conflita -> pula).
 * Remarcação muda inicio_at -> chave nova legítima (lembra do horário novo).
 *
 * ENVIO seguro (estilo client-alert): timeout duro por sendText (regra 7), typing+delay
 * humanizador, teto por sessão (anti-flood/ban), fail-safe (falha de 1 envio NÃO derruba o
 * job nem afeta outros clientes — regra de ouro 7/8). Falha marca o claim como 'failed'.
 *
 * LGPD (regra de ouro 6): NUNCA loga telefone/nome do cliente em claro — só phoneHint, slot,
 * atendimentoId e janela. O conteúdo da mensagem não é persistido.
 *
 * COPY DO TEMPLATE: o template default (packages/core/src/reminders.ts,
 * DEFAULT_REMINDER_TEMPLATE) é PRA O BRUNO REVISAR antes de ir pra cliente real.
 */
import { createHash } from 'node:crypto';
import { logger } from '@startap/core/logger';
import {
  isWindowDue,
  minutesUntil,
  renderReminderTemplate,
  resolveWindows,
} from '@startap/core/reminders';
import { type DueReminderRow, reminders } from '@startap/db';
import { waha } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ job: 'reminders' });

export interface RemindersResult extends Record<string, unknown> {
  /** quantos atendimentos a varredura olhou. */
  scanned: number;
  /** quantos lembretes saíram com sucesso. */
  sent: number;
  /** quantos foram pulados por já estarem reservados/enviados (idempotência). */
  skippedDuplicate: number;
  /** quantos pulados por não terem cliente_contato (sem destino). */
  skippedNoContact: number;
  /** quantos pulados por não terem sessão WAHA no clone. */
  skippedNoSession: number;
  /** quantos pulados pelo teto por sessão neste ciclo. */
  skippedCapped: number;
  /** quantos envios falharam (claim marcado 'failed'). */
  failed: number;
}

/** Mascara telefone para log (LGPD): 5535999991234 -> 5535****1234. */
function phoneHint(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 8) return '***';
  return `${d.slice(0, 4)}****${d.slice(-4)}`;
}

/** Normaliza telefone (só dígitos) -> chatId WhatsApp. '' se inválido. */
function toChatId(phone: string): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  return `${d}@c.us`;
}

/** Chave de log estável de uma sessão (não loga a sessão crua — basta um hash curto). */
function sessionKey(sessao: string): string {
  return createHash('sha256').update(sessao).digest('hex').slice(0, 8);
}

/**
 * Decide, para um atendimento, qual janela configurada está NO GATILHO agora (a primeira que
 * casar — janelas são únicas e o atendimento só dispara 1 lembrete por ciclo por evento). PURA
 * via core (isWindowDue). Retorna a janela em minutos ou null se nenhuma casa.
 */
function dueWindowFor(row: DueReminderRow, now: Date): number | null {
  const inicio = new Date(row.inicio_at);
  if (Number.isNaN(inicio.getTime())) return null;
  const mins = minutesUntil(inicio, now);
  const windows = resolveWindows(row.reminder_windows_min);
  for (const w of windows) {
    if (isWindowDue(w, mins, config.REMINDERS_TOLERANCE_MIN)) return w;
  }
  return null;
}

/**
 * Envia 1 lembrete pela sessão do clone, com timeout duro + typing/delay. Lança em falha (o
 * caller captura e marca 'failed'). NÃO loga PII.
 */
async function sendReminder(row: DueReminderRow, chatId: string): Promise<void> {
  const texto = renderReminderTemplate({
    clienteNome: row.cliente_nome,
    servicoNome: row.servico_nome,
    inicioAt: new Date(row.inicio_at),
    // SOLO/individual: profissional_nome NULL -> {profissional} é omitido no render.
    profissionalNome: row.profissional_nome,
    negocio: row.display_name,
    template: row.reminder_template,
    // Fuso do clone (default SP) — {horario} no relógio da barbearia (idêntico p/ SP).
    timeZone: row.timezone,
  });

  await Promise.race([
    waha.sendText({
      // Envia pela sessão do PRÓPRIO clone (isolamento — nunca cross-cliente).
      sessao: row.waha_sessao as string,
      chatId,
      texto,
      typing: true,
      delayMs: config.REMINDERS_TYPING_DELAY_MS,
      shardId: row.waha_shard_id,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('sendText timeout')), config.REMINDERS_SEND_TIMEOUT_MS),
    ),
  ]);
}

export async function runReminders(): Promise<RemindersResult> {
  const result: RemindersResult = {
    scanned: 0,
    sent: 0,
    skippedDuplicate: 0,
    skippedNoContact: 0,
    skippedNoSession: 0,
    skippedCapped: 0,
    failed: 0,
  };

  // Gate global (defesa em profundidade — o cron nem é registrado com a flag OFF, mas se
  // alguém chamar runReminders direto, ainda é NO-OP).
  if (!config.REMINDERS_ENABLED) return result;

  let due: DueReminderRow[] = [];
  try {
    due = await reminders.findDueAgendaAtendimentos(config.REMINDERS_HORIZON_MIN);
  } catch (err) {
    // Falha de leitura não derruba o worker nem afeta atendimento. Loga e segue (ciclo vazio).
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'reminders: varredura falhou — ciclo vazio',
    );
    return result;
  }

  const now = new Date();
  result.scanned = due.length;

  // Teto por sessão WAHA neste ciclo (anti-flood/ban da sessão do clone).
  const sentPerSession = new Map<string, number>();

  for (const row of due) {
    const windowMin = dueWindowFor(row, now);
    if (windowMin == null) continue; // ainda não entrou em nenhuma janela

    // Sem sessão do clone -> não há por onde enviar. Pula (sem erro).
    if (!row.waha_sessao) {
      result.skippedNoSession++;
      continue;
    }
    // Sem telefone do cliente -> não há destino. Pula (sem erro).
    const chatId = row.cliente_contato ? toChatId(row.cliente_contato) : null;
    if (!chatId) {
      result.skippedNoContact++;
      continue;
    }

    // Teto por sessão (anti-flood). Acima -> deixa pro próximo ciclo (não claima ainda).
    const sKey = row.waha_sessao;
    const already = sentPerSession.get(sKey) ?? 0;
    if (already >= config.REMINDERS_MAX_PER_SESSION) {
      result.skippedCapped++;
      continue;
    }

    // CLAIM idempotente ANTES de enviar: ganha a corrida = envia; conflito = já reservado -> pula.
    let claim: { id: number } | null;
    try {
      claim = await reminders.claimReminder({
        atendimentoId: row.atendimento_id,
        slot: row.slot,
        tenantId: row.tenant_id,
        windowMin,
        inicioAt: row.inicio_at,
      });
    } catch (err) {
      // Falha no claim (DB): não envia (sem claim não há idempotência). Loga e segue.
      log.error(
        {
          slot: row.slot,
          atendimentoId: row.atendimento_id,
          windowMin,
          err: err instanceof Error ? err.message : String(err),
        },
        'reminders: claim falhou — pula (sem envio)',
      );
      continue;
    }
    if (!claim) {
      result.skippedDuplicate++;
      continue;
    }

    // Envio. Falha -> marca o claim como 'failed' (não re-tenta; one-way sem fila de retry) e
    // segue pro próximo (isolamento: 1 falha não derruba os outros).
    try {
      await sendReminder(row, chatId);
      sentPerSession.set(sKey, already + 1);
      result.sent++;
      log.info(
        {
          slot: row.slot,
          atendimentoId: row.atendimento_id,
          windowMin,
          sessaoHint: sessionKey(row.waha_sessao),
          clientHint: phoneHint(row.cliente_contato ?? ''),
        },
        'reminders: lembrete enviado',
      );
    } catch (err) {
      result.failed++;
      await reminders.markReminderFailed(claim.id).catch(() => {});
      log.error(
        {
          slot: row.slot,
          atendimentoId: row.atendimento_id,
          windowMin,
          err: err instanceof Error ? err.message : String(err),
        },
        'reminders: envio falhou — claim marcado failed, segue',
      );
    }
  }

  return result;
}
