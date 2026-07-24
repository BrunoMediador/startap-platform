import { randomUUID } from 'node:crypto';
import { logger } from '@startap/core/logger';
import { flowExecutionLog } from '@startap/db';
/**
 * Worker — roda cron jobs.
 *
 * Substitui as triggers Schedule do automação visual antiga.
 */
import { Cron } from 'croner';
import { config } from './config.js';
import { runAntibot } from './jobs/antibot.js';
import { runBillingSilenceAlert } from './jobs/billing-silence-alert.js';
import { runBotDetectAutopause } from './jobs/bot-detect-autopause.js';
import { runBotDetect } from './jobs/bot-detect.js';
import { runCleanupBotPausa } from './jobs/cleanup-bot-pausa.js';
import { runCleanupChat } from './jobs/cleanup-chat.js';
import { runCleanupTrialOrphans } from './jobs/cleanup-trial-orphans.js';
import { runCloseStaleRunning } from './jobs/close-stale-running.js';
import { runGcalAtendSync } from './jobs/gcal-atend-sync.js';
import { runGcalHealthcheck } from './jobs/gcal-healthcheck.js';
import { runGenerateBillingCharges } from './jobs/generate-billing-charges.js';
import { runMessageAckAlert } from './jobs/message-ack-alert.js';
import { runMonitor } from './jobs/monitor.js';
import { runReconcilePackages } from './jobs/reconcile-packages.js';
import { runReminders } from './jobs/reminders.js';

const log = logger.child({ service: 'worker' });

/**
 * Registra um cron cujo PATTERN vem de env: pattern inválido NUNCA crasha o
 * boot do worker (lição #247) — cai pro fallback hardcoded e loga alto.
 */
function scheduleCronSafe(
  pattern: string,
  fallback: string,
  opts: ConstructorParameters<typeof Cron>[1],
  fn: () => Promise<void>,
): Cron {
  try {
    return new Cron(pattern, opts, fn);
  } catch (e) {
    log.error(
      { pattern, fallback, err: e instanceof Error ? e.message : String(e) },
      'cron pattern inválido vindo de env — usando fallback',
    );
    return new Cron(fallback, opts, fn);
  }
}

async function main() {
  log.info('Worker startup');

  // Antibot: cada 1 minuto
  new Cron('* * * * *', { name: 'antibot' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    let jobResult: Awaited<ReturnType<typeof runAntibot>> | null = null;
    let jobError: unknown = null;
    await flowExecutionLog.logFlowEvent({
      executionId,
      flowId: 'worker:antibot',
      flowName: 'antibot',
      bot: 'worker',
      eventType: 'worker.job-started',
      status: 'running',
      message: 'Job antibot iniciado',
    });
    try {
      // ANTIBOT_ALLOWLIST_ENABLED (SCRUM-4 PR-A): default OFF -> não pausa quem já agendou.
      jobResult = await runAntibot({ allowlistEnabled: config.ANTIBOT_ALLOWLIST_ENABLED });
      if (jobResult.blocked > 0 || jobResult.skipped > 0)
        log.info({ ...jobResult }, 'antibot cycle');
    } catch (e) {
      jobError = e;
      log.error({ err: e }, 'antibot crashed');
    } finally {
      // Garante INSERT do status final mesmo que runAntibot lance exceção não capturada.
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:antibot',
        flowName: 'antibot',
        bot: 'worker',
        eventType: jobError ? 'worker.job-failed' : 'worker.job-finished',
        status: jobError ? 'error' : 'success',
        message: jobError ? 'Job antibot falhou' : 'Job antibot concluído',
        ...(jobResult ? { metadata: jobResult } : {}),
        ...(jobError ? { error: jobError } : {}),
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Cleanup: a cada 1 hora — cobre clones ativos que antes ficavam 12h sem limpar
  new Cron('0 * * * *', { name: 'cleanup-chat', timezone: 'America/Sao_Paulo' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    let cleanupResult: Awaited<ReturnType<typeof runCleanupChat>> | null = null;
    let cleanupError: unknown = null;
    await flowExecutionLog.logFlowEvent({
      executionId,
      flowId: 'worker:cleanup-chat',
      flowName: 'cleanup-chat',
      bot: 'worker',
      eventType: 'worker.job-started',
      status: 'running',
      message: 'Job cleanup-chat iniciado',
    });
    try {
      cleanupResult = await runCleanupChat();
      log.info({ ...cleanupResult }, 'cleanup cycle');
      const botPausaResult = await runCleanupBotPausa();
      if (botPausaResult.deleted > 0) log.info({ ...botPausaResult }, 'cleanup-bot-pausa cycle');
      const prunedLogs = await flowExecutionLog.pruneOldFlowEvents(14);
      // Fecha execuções presas em running há mais de 5 minutos (safety net).
      const closedStale = await flowExecutionLog.closeStaleRunning(5);
      if (closedStale > 0) log.warn({ closedStale }, 'Execuções presas em running fechadas');
      Object.assign(cleanupResult as object, { prunedFlowLogs: prunedLogs, closedStale });
    } catch (e) {
      cleanupError = e;
      log.error({ err: e }, 'cleanup crashed');
    } finally {
      // Garante INSERT do status final mesmo que runCleanupChat lance exceção não capturada.
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:cleanup-chat',
        flowName: 'cleanup-chat',
        bot: 'worker',
        eventType: cleanupError ? 'worker.job-failed' : 'worker.job-finished',
        status: cleanupError ? 'error' : 'success',
        message: cleanupError ? 'Job cleanup-chat falhou' : 'Job cleanup-chat concluído',
        ...(cleanupResult ? { metadata: cleanupResult } : {}),
        ...(cleanupError ? { error: cleanupError } : {}),
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Close-stale-running: a cada 15 min — fecha execs presas em running > CHAT_STALE_RUNNING_MAX_MINUTES (default 30)
  new Cron('*/15 * * * *', { name: 'close-stale-running' }, async () => {
    const executionId = randomUUID();
    const startedAt = Date.now();
    let staleResult: Awaited<ReturnType<typeof runCloseStaleRunning>> | null = null;
    let staleError: unknown = null;
    await flowExecutionLog.logFlowEvent({
      executionId,
      flowId: 'worker:close-stale-running',
      flowName: 'close-stale-running',
      bot: 'worker',
      eventType: 'worker.job-started',
      status: 'running',
      message: 'Job close-stale-running iniciado',
    });
    try {
      staleResult = await runCloseStaleRunning();
      if (staleResult.closed > 0) log.warn({ ...staleResult }, 'close-stale-running cycle');
    } catch (e) {
      staleError = e;
      log.error({ err: e }, 'close-stale-running crashed');
    } finally {
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:close-stale-running',
        flowName: 'close-stale-running',
        bot: 'worker',
        eventType: staleError ? 'worker.job-failed' : 'worker.job-finished',
        status: staleError ? 'error' : 'success',
        message: staleError
          ? 'Job close-stale-running falhou'
          : 'Job close-stale-running concluído',
        ...(staleResult ? { metadata: staleResult } : {}),
        ...(staleError ? { error: staleError } : {}),
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Billing F4 (ADR 0014 §G): 1x/dia as 08:00 America/Sao_Paulo. Geracao + reconciliacao +
  // expiracao de cobrancas PIX. ATRAS da flag BILLING_DUE_DATE_MODEL — com a flag OFF o job
  // e NO-OP (nao le billing, nao instancia gateway, nao toca banco). SEM aviso ao cliente.
  new Cron(
    '0 8 * * *',
    { name: 'generate-billing-charges', timezone: 'America/Sao_Paulo' },
    async () => {
      const executionId = randomUUID();
      const startedAt = Date.now();
      let billingResult: Awaited<ReturnType<typeof runGenerateBillingCharges>> | null = null;
      let billingError: unknown = null;
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:generate-billing-charges',
        flowName: 'generate-billing-charges',
        bot: 'worker',
        eventType: 'worker.job-started',
        status: 'running',
        message: 'Job generate-billing-charges iniciado',
      });
      try {
        billingResult = await runGenerateBillingCharges();
        if (!billingResult.skipped) log.info({ ...billingResult }, 'billing F4 cycle');
      } catch (e) {
        billingError = e;
        log.error({ err: e }, 'generate-billing-charges crashed');
      } finally {
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:generate-billing-charges',
          flowName: 'generate-billing-charges',
          bot: 'worker',
          eventType: billingError ? 'worker.job-failed' : 'worker.job-finished',
          status: billingError ? 'error' : 'success',
          message: billingError
            ? 'Job generate-billing-charges falhou'
            : 'Job generate-billing-charges concluído',
          ...(billingResult ? { metadata: billingResult } : {}),
          ...(billingError ? { error: billingError } : {}),
          durationMs: Date.now() - startedAt,
        });
      }
    },
  );

  // Trials órfãos (Missão 020 F1 — condição 2 do PORTAL_SIGNUP): horário por
  // default (env TRIAL_ORPHAN_CRON, fallback :30 pra não colidir com o
  // cleanup-chat de :00). Com PORTAL_SIGNUP OFF não existe clone
  // trial_status='awaiting' => o job roda e não faz nada (no-op barato).
  scheduleCronSafe(
    config.TRIAL_ORPHAN_CRON,
    '30 * * * *',
    { name: 'cleanup-trial-orphans', timezone: 'America/Sao_Paulo' },
    async () => {
      const executionId = randomUUID();
      const startedAt = Date.now();
      let orphanResult: Awaited<ReturnType<typeof runCleanupTrialOrphans>> | null = null;
      let orphanError: unknown = null;
      await flowExecutionLog.logFlowEvent({
        executionId,
        flowId: 'worker:cleanup-trial-orphans',
        flowName: 'cleanup-trial-orphans',
        bot: 'worker',
        eventType: 'worker.job-started',
        status: 'running',
        message: 'Job cleanup-trial-orphans iniciado',
      });
      try {
        orphanResult = await runCleanupTrialOrphans();
        // Só loga ciclo com atividade — com PORTAL_SIGNUP OFF o no-op fica mudo.
        if (orphanResult.scanned > 0) log.info({ ...orphanResult }, 'cleanup-trial-orphans cycle');
      } catch (e) {
        orphanError = e;
        log.error({ err: e }, 'cleanup-trial-orphans crashed');
      } finally {
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:cleanup-trial-orphans',
          flowName: 'cleanup-trial-orphans',
          bot: 'worker',
          eventType: orphanError ? 'worker.job-failed' : 'worker.job-finished',
          status: orphanError ? 'error' : 'success',
          message: orphanError
            ? 'Job cleanup-trial-orphans falhou'
            : 'Job cleanup-trial-orphans concluído',
          ...(orphanResult ? { metadata: orphanResult } : {}),
          ...(orphanError ? { error: orphanError } : {}),
          durationMs: Date.now() - startedAt,
        });
      }
    },
  );

  // Monitor de alertas internos (Missão 021, Fase 1) — camada 1 do rollout:
  // SÓ registra o cron se ALERTS_ENABLED=true (default OFF). Com a env ausente o
  // worker sobe normal e este cron NÃO existe (zero chamada a WAHA/health/envio).
  // Camada 2 (toggle quente alert_config.enabled) vive no próprio runMonitor.
  // A cada 2 min (ALERTS_CRON, default */2). Padrão inválido cai no fallback.
  if (config.ALERTS_ENABLED) {
    log.info(
      { cron: config.ALERTS_CRON },
      'monitor de alertas: cron registrado (ALERTS_ENABLED=true)',
    );
    scheduleCronSafe(
      config.ALERTS_CRON,
      '*/2 * * * *',
      { name: 'monitor', timezone: 'America/Sao_Paulo' },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let monitorResult: Awaited<ReturnType<typeof runMonitor>> | null = null;
        let monitorError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:monitor',
          flowName: 'monitor',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job monitor iniciado',
        });
        try {
          monitorResult = await runMonitor();
          // Com o toggle de banco OFF (skipped) ou tudo UP/silêncio, fica mudo.
          if (monitorResult.sent > 0 || monitorResult.down > 0 || monitorResult.suppressed > 0) {
            log.warn({ ...monitorResult }, 'monitor: atividade neste ciclo');
          }
        } catch (e) {
          monitorError = e;
          log.error({ err: e }, 'monitor crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:monitor',
            flowName: 'monitor',
            bot: 'worker',
            eventType: monitorError ? 'worker.job-failed' : 'worker.job-finished',
            status: monitorError ? 'error' : 'success',
            message: monitorError ? 'Job monitor falhou' : 'Job monitor concluído',
            ...(monitorResult ? { metadata: monitorResult } : {}),
            ...(monitorError ? { error: monitorError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info('monitor de alertas: ALERTS_ENABLED ausente/false — cron NÃO registrado');
  }

  // Reconciliação de pacotes (ADR 0025 dívida 5: cancelar+reagendar) — RELATÓRIO read-only
  // de suspeitas de dupla-baixa pra ops agir. SÓ registra com PACOTES_RECONCILE_ENABLED=true
  // (default OFF). Com a flag OFF o cron nem existe (zero query). Ligar junto com o rollout
  // de PACOTES_ENABLED, ANTES de escalar pacotes pra muitos clientes (review #321).
  if (config.PACOTES_RECONCILE_ENABLED) {
    log.info(
      { cron: config.PACOTES_RECONCILE_CRON },
      'reconcile-packages: cron registrado (PACOTES_RECONCILE_ENABLED=true)',
    );
    scheduleCronSafe(
      config.PACOTES_RECONCILE_CRON,
      '0 9 * * *',
      { name: 'reconcile-packages', timezone: 'America/Sao_Paulo' },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let reconcileResult: Awaited<ReturnType<typeof runReconcilePackages>> | null = null;
        let reconcileError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:reconcile-packages',
          flowName: 'reconcile-packages',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job reconcile-packages iniciado',
        });
        try {
          reconcileResult = await runReconcilePackages();
          if (reconcileResult.suspects > 0) {
            log.warn({ ...reconcileResult }, 'reconcile-packages: suspeitas encontradas');
          }
        } catch (e) {
          reconcileError = e;
          log.error({ err: e }, 'reconcile-packages crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:reconcile-packages',
            flowName: 'reconcile-packages',
            bot: 'worker',
            eventType: reconcileError ? 'worker.job-failed' : 'worker.job-finished',
            status: reconcileError ? 'error' : 'success',
            message: reconcileError
              ? 'Job reconcile-packages falhou'
              : 'Job reconcile-packages concluído',
            ...(reconcileResult ? { metadata: reconcileResult } : {}),
            ...(reconcileError ? { error: reconcileError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info('reconcile-packages: PACOTES_RECONCILE_ENABLED ausente/false — cron NÃO registrado');
  }

  // Lembrete de agendamento (one-way, configurável por clone — migration 060). Camada 1 do
  // rollout: SÓ registra o cron com REMINDERS_ENABLED=true (default OFF). Com a env ausente o
  // worker sobe normal e este cron NÃO existe (zero query/WAHA). Camada 2 (gate por-clone
  // flow_clones.reminders_enabled) vive no SQL do runReminders. A cada 5 min (REMINDERS_CRON,
  // default */5). Padrão inválido cai no fallback via scheduleCronSafe.
  if (config.REMINDERS_ENABLED) {
    log.info(
      { cron: config.REMINDERS_CRON },
      'reminders: cron registrado (REMINDERS_ENABLED=true)',
    );
    scheduleCronSafe(
      config.REMINDERS_CRON,
      '*/5 * * * *',
      { name: 'reminders', timezone: 'America/Sao_Paulo' },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let remindersResult: Awaited<ReturnType<typeof runReminders>> | null = null;
        let remindersError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:reminders',
          flowName: 'reminders',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job reminders iniciado',
        });
        try {
          remindersResult = await runReminders();
          // Só loga ciclo com atividade — com 0 clientes due fica mudo.
          if (remindersResult.sent > 0 || remindersResult.failed > 0) {
            log.info({ ...remindersResult }, 'reminders cycle');
          }
        } catch (e) {
          remindersError = e;
          log.error({ err: e }, 'reminders crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:reminders',
            flowName: 'reminders',
            bot: 'worker',
            eventType: remindersError ? 'worker.job-failed' : 'worker.job-finished',
            status: remindersError ? 'error' : 'success',
            message: remindersError ? 'Job reminders falhou' : 'Job reminders concluído',
            ...(remindersResult ? { metadata: remindersResult } : {}),
            ...(remindersError ? { error: remindersError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info('reminders: REMINDERS_ENABLED ausente/false — cron NÃO registrado');
  }

  // Health-check do Google Calendar (SCRUM-27 — fim do "active mentiroso"). Revalida as agendas
  // marcadas 'active' (clones individuais + colaboradores de estabelecimento) reusando o
  // testConnection() do painel; quem quebrou cai pra 'invalid' (o bot para de prometer agenda
  // que não existe). GATE: SÓ registra o cron com GCAL_HEALTHCHECK_ENABLED=true (default OFF —
  // lição #247). Com a env ausente o worker sobe normal e este cron NÃO existe (zero query, zero
  // chamada ao Google). A cada 2h (GCAL_HEALTHCHECK_CRON, default '23 */2'). Padrão inválido cai
  // no fallback via scheduleCronSafe. ⚠️ Ligar ON/OFF em prod = decisão do Bruno (ver corpo do PR).
  if (config.GCAL_HEALTHCHECK_ENABLED) {
    log.info(
      { cron: config.GCAL_HEALTHCHECK_CRON },
      'gcal-healthcheck: cron registrado (GCAL_HEALTHCHECK_ENABLED=true)',
    );
    scheduleCronSafe(
      config.GCAL_HEALTHCHECK_CRON,
      '23 */2 * * *',
      { name: 'gcal-healthcheck', timezone: 'America/Sao_Paulo' },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let gcalResult: Awaited<ReturnType<typeof runGcalHealthcheck>> | null = null;
        let gcalError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:gcal-healthcheck',
          flowName: 'gcal-healthcheck',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job gcal-healthcheck iniciado',
        });
        try {
          gcalResult = await runGcalHealthcheck();
          // Só loga ciclo com atividade relevante — sem demoções/inconclusivos fica mudo.
          if (gcalResult.demoted > 0 || gcalResult.inconclusive > 0) {
            log.warn({ ...gcalResult }, 'gcal-healthcheck: atividade neste ciclo');
          }
        } catch (e) {
          gcalError = e;
          log.error({ err: e }, 'gcal-healthcheck crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:gcal-healthcheck',
            flowName: 'gcal-healthcheck',
            bot: 'worker',
            eventType: gcalError ? 'worker.job-failed' : 'worker.job-finished',
            status: gcalError ? 'error' : 'success',
            message: gcalError ? 'Job gcal-healthcheck falhou' : 'Job gcal-healthcheck concluído',
            ...(gcalResult ? { metadata: gcalResult } : {}),
            ...(gcalError ? { error: gcalError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info('gcal-healthcheck: GCAL_HEALTHCHECK_ENABLED ausente/false — cron NÃO registrado');
  }

  // Detecção de bot (SCRUM-4 PR-C, Fase 1: heurística + alerta-only, NÃO pausa). Camada 1 do
  // rollout: SÓ registra o cron com BOT_DETECT_ENABLED=true (default OFF — lição #247). Com a env
  // ausente o worker sobe normal e este cron NÃO existe (zero query, zero WAHA). Camada 2 (gate
  // por-clone BOT_DETECT_SLOTS) vive dentro do runBotDetect — sem slots = NO-OP. A cada hora
  // (BOT_DETECT_CRON, default '17 * * * *'). Padrão inválido cai no fallback via scheduleCronSafe.
  if (config.BOT_DETECT_ENABLED) {
    log.info(
      { cron: config.BOT_DETECT_CRON },
      'bot-detect: cron registrado (BOT_DETECT_ENABLED=true)',
    );
    scheduleCronSafe(
      config.BOT_DETECT_CRON,
      '17 * * * *',
      { name: 'bot-detect', timezone: 'America/Sao_Paulo' },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let botDetectResult: Awaited<ReturnType<typeof runBotDetect>> | null = null;
        let botDetectError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:bot-detect',
          flowName: 'bot-detect',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job bot-detect iniciado',
        });
        try {
          botDetectResult = await runBotDetect();
          // Só loga ciclo com atividade — sem candidatos novos fica mudo.
          if (
            !botDetectResult.skipped &&
            (botDetectResult.bots > 0 ||
              botDetectResult.alerts > 0 ||
              botDetectResult.classified > 0)
          ) {
            log.info({ ...botDetectResult }, 'bot-detect cycle');
          }

          // PR-E (Fase 2): passo ADITIVO de escalação -> auto-pausa + TTL/reversão. Gated por
          // BOT_DETECT_AUTOPAUSE (default OFF). Com a flag ausente/false é NO-OP total (zero query)
          // — a detecção/alerta da Fase 1 segue idêntica. Falha aqui NÃO derruba o ciclo do detect.
          if (config.BOT_DETECT_AUTOPAUSE) {
            try {
              const autopause = await runBotDetectAutopause();
              if (
                !autopause.skipped &&
                (autopause.paused > 0 || autopause.ttlExpired > 0 || autopause.autoResumed > 0)
              ) {
                log.info({ ...autopause }, 'bot-detect-autopause cycle');
              }
            } catch (e) {
              log.error({ err: e }, 'bot-detect-autopause crashed');
            }
          }
        } catch (e) {
          botDetectError = e;
          log.error({ err: e }, 'bot-detect crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:bot-detect',
            flowName: 'bot-detect',
            bot: 'worker',
            eventType: botDetectError ? 'worker.job-failed' : 'worker.job-finished',
            status: botDetectError ? 'error' : 'success',
            message: botDetectError ? 'Job bot-detect falhou' : 'Job bot-detect concluído',
            ...(botDetectResult ? { metadata: botDetectResult } : {}),
            ...(botDetectError ? { error: botDetectError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info('bot-detect: BOT_DETECT_ENABLED ausente/false — cron NÃO registrado');
  }

  // Alerta interno de bot PAGANTE silenciado por inadimplência (SCRUM-67) — VISIBILIDADE, não muda o
  // gate. Camada 1 do rollout: SÓ registra o cron com BILLING_SILENCE_ALERT_ENABLED=true (default OFF —
  // lição #247). Com a env ausente o worker sobe normal e este cron NÃO existe (zero query, zero WAHA).
  // Camada 2: o job só age quando o PRÓPRIO gate de silêncio está ON (process.env.BILLING_OVERDUE_SILENCE
  // === 'true', mesma fonte do router) — com o gate OFF é NO-OP (nenhum alerta falso). { protect:true }
  // impede overlap de ciclos. A cada hora no :43 (BILLING_SILENCE_ALERT_CRON). Padrão inválido cai no
  // fallback via scheduleCronSafe. ⚠️ Decisão ON/OFF em prod é do Bruno (ver corpo do PR).
  if (config.BILLING_SILENCE_ALERT_ENABLED) {
    log.info(
      { cron: config.BILLING_SILENCE_ALERT_CRON },
      'billing-silence-alert: cron registrado (BILLING_SILENCE_ALERT_ENABLED=true)',
    );
    scheduleCronSafe(
      config.BILLING_SILENCE_ALERT_CRON,
      '43 * * * *',
      { name: 'billing-silence-alert', timezone: 'America/Sao_Paulo', protect: true },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let silenceResult: Awaited<ReturnType<typeof runBillingSilenceAlert>> | null = null;
        let silenceError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:billing-silence-alert',
          flowName: 'billing-silence-alert',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job billing-silence-alert iniciado',
        });
        try {
          silenceResult = await runBillingSilenceAlert({
            // Espelha o gate real do router (mesma env). Missing no worker = OFF = NO-OP seguro.
            overdueSilenceEnabled: process.env.BILLING_OVERDUE_SILENCE === 'true',
            cooldownMin: config.BILLING_SILENCE_ALERT_COOLDOWN_MIN,
          });
          // Só loga ciclo com atividade — sem silenciados/alertas fica mudo.
          if (!silenceResult.skipped && (silenceResult.silenced > 0 || silenceResult.alerted > 0)) {
            log.warn(
              { ...silenceResult },
              'billing-silence-alert: pagante(s) silenciado(s) por atraso',
            );
          }
        } catch (e) {
          silenceError = e;
          log.error({ err: e }, 'billing-silence-alert crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:billing-silence-alert',
            flowName: 'billing-silence-alert',
            bot: 'worker',
            eventType: silenceError ? 'worker.job-failed' : 'worker.job-finished',
            status: silenceError ? 'error' : 'success',
            message: silenceError
              ? 'Job billing-silence-alert falhou'
              : 'Job billing-silence-alert concluído',
            ...(silenceResult ? { metadata: silenceResult } : {}),
            ...(silenceError ? { error: silenceError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info(
      'billing-silence-alert: BILLING_SILENCE_ALERT_ENABLED ausente/false — cron NÃO registrado',
    );
  }

  // Rastreio de ENTREGA de outbound: alerta de nack terminal (463/ack -1) + outbound preso sem
  // entrega (SCRUM-58). Camada 1 do rollout: SÓ registra o cron com MESSAGE_ACK_TRACKING_ENABLED=true
  // (default OFF — lição #247). Com a env ausente o worker sobe normal e este cron NÃO existe (zero
  // query, zero WAHA) E o api não registra/atualiza nada (byte-idêntico). { protect:true } impede
  // overlap. A cada 5 min no offset :2 (MESSAGE_ACK_ALERT_CRON). Padrão inválido cai no fallback via
  // scheduleCronSafe. ⚠️ Decisão ON/OFF em prod é do Bruno (ver corpo do PR). A env precisa estar ON
  // TAMBÉM no api (registro + handler do ack) + assinar message.ack nas sessões WAHA.
  if (config.MESSAGE_ACK_TRACKING_ENABLED) {
    log.info(
      { cron: config.MESSAGE_ACK_ALERT_CRON },
      'message-ack-alert: cron registrado (MESSAGE_ACK_TRACKING_ENABLED=true)',
    );
    scheduleCronSafe(
      config.MESSAGE_ACK_ALERT_CRON,
      '2-59/5 * * * *',
      { name: 'message-ack-alert', timezone: 'America/Sao_Paulo', protect: true },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let ackResult: Awaited<ReturnType<typeof runMessageAckAlert>> | null = null;
        let ackError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:message-ack-alert',
          flowName: 'message-ack-alert',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job message-ack-alert iniciado',
        });
        try {
          ackResult = await runMessageAckAlert({
            stuckMin: config.MESSAGE_ACK_STUCK_MIN,
            cooldownMin: config.MESSAGE_ACK_ALERT_COOLDOWN_MIN,
            maxPerRun: config.MESSAGE_ACK_ALERT_MAX_PER_RUN,
            retentionDays: config.MESSAGE_ACK_RETENTION_DAYS,
          });
          // Só loga ciclo com atividade — sem entrega falhando fica mudo.
          if (ackResult.alerted > 0 || ackResult.sessions > 0 || ackResult.sendFailed > 0) {
            log.warn({ ...ackResult }, 'message-ack-alert: entrega falhando neste ciclo');
          }
        } catch (e) {
          ackError = e;
          log.error({ err: e }, 'message-ack-alert crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:message-ack-alert',
            flowName: 'message-ack-alert',
            bot: 'worker',
            eventType: ackError ? 'worker.job-failed' : 'worker.job-finished',
            status: ackError ? 'error' : 'success',
            message: ackError ? 'Job message-ack-alert falhou' : 'Job message-ack-alert concluído',
            ...(ackResult ? { metadata: ackResult } : {}),
            ...(ackError ? { error: ackError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info('message-ack-alert: MESSAGE_ACK_TRACKING_ENABLED ausente/false — cron NÃO registrado');
  }

  // Sync periódico GCal→atendimentos (SCRUM-89 / ADR 0031 — Faturamento espelha a agenda). Reconcilia
  // por clone com o gate billing-da-agenda ON: UPSERT de todo evento presente (inclusive os criados à
  // mão no GCal) + DELETE (soft) das linhas origem='agenda' cujo evento sumiu — SÓ sobre listagem
  // COMPLETA (fail-safe). GATE: SÓ registra o cron com GCAL_ATEND_SYNC_ENABLED=true (default OFF —
  // lição #247). Com a env ausente o worker sobe normal e este cron NÃO existe (zero query, zero GCal).
  // { protect:true } impede overlap de ciclos. De hora em hora no :37 (GCAL_ATEND_SYNC_CRON). Padrão
  // inválido cai no fallback via scheduleCronSafe. ⚠️ Ligar ON/OFF em prod = decisão do Bruno (ver PR).
  // ⚠️ Deploy: ATEND_FROM_AGENDA_SLOTS precisa estar no container do worker (hoje só no api/portal-api),
  // senão só os clones gated por COLUNA (Ingrid) seriam reconciliados.
  if (config.GCAL_ATEND_SYNC_ENABLED) {
    log.info(
      { cron: config.GCAL_ATEND_SYNC_CRON },
      'gcal-atend-sync: cron registrado (GCAL_ATEND_SYNC_ENABLED=true)',
    );
    scheduleCronSafe(
      config.GCAL_ATEND_SYNC_CRON,
      '37 * * * *',
      { name: 'gcal-atend-sync', timezone: 'America/Sao_Paulo', protect: true },
      async () => {
        const executionId = randomUUID();
        const startedAt = Date.now();
        let syncResult: Awaited<ReturnType<typeof runGcalAtendSync>> | null = null;
        let syncError: unknown = null;
        await flowExecutionLog.logFlowEvent({
          executionId,
          flowId: 'worker:gcal-atend-sync',
          flowName: 'gcal-atend-sync',
          bot: 'worker',
          eventType: 'worker.job-started',
          status: 'running',
          message: 'Job gcal-atend-sync iniciado',
        });
        try {
          syncResult = await runGcalAtendSync();
          // Só loga ciclo com atividade relevante — sem upsert/delete/erro fica mudo.
          if (
            syncResult.upserted > 0 ||
            syncResult.deleted > 0 ||
            syncResult.skippedIncomplete > 0 ||
            syncResult.skippedNoGcal > 0 ||
            syncResult.deletionsSkippedColabAbsent > 0 ||
            syncResult.slotsWithError > 0
          ) {
            log.info({ ...syncResult }, 'gcal-atend-sync: atividade neste ciclo');
          }
        } catch (e) {
          syncError = e;
          log.error({ err: e }, 'gcal-atend-sync crashed');
        } finally {
          await flowExecutionLog.logFlowEvent({
            executionId,
            flowId: 'worker:gcal-atend-sync',
            flowName: 'gcal-atend-sync',
            bot: 'worker',
            eventType: syncError ? 'worker.job-failed' : 'worker.job-finished',
            status: syncError ? 'error' : 'success',
            message: syncError ? 'Job gcal-atend-sync falhou' : 'Job gcal-atend-sync concluído',
            ...(syncResult ? { metadata: syncResult } : {}),
            ...(syncError ? { error: syncError } : {}),
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  } else {
    log.info('gcal-atend-sync: GCAL_ATEND_SYNC_ENABLED ausente/false — cron NÃO registrado');
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log.info({ sig }, 'shutdown');
      process.exit(0);
    });
  }
}

main().catch((e) => {
  log.error({ err: e }, 'fatal');
  process.exit(1);
});
