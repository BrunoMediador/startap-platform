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
import { runCleanupBotPausa } from './jobs/cleanup-bot-pausa.js';
import { runCleanupChat } from './jobs/cleanup-chat.js';
import { runCleanupTrialOrphans } from './jobs/cleanup-trial-orphans.js';
import { runCloseStaleRunning } from './jobs/close-stale-running.js';
import { runGcalHealthcheck } from './jobs/gcal-healthcheck.js';
import { runGenerateBillingCharges } from './jobs/generate-billing-charges.js';
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
