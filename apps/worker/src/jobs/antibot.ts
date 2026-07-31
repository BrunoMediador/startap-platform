/**
 * Job antibot — roda a cada 1 minuto.
 *
 * Substitui Monitor_AntiBot do automacao visual antiga.
 *
 * Detecta numeros enviando 6+ mensagens em 60s e grava em flow_pauses
 * (source=antibot) por fluxo. Resolve flow_id em duas etapas:
 *   1. routing_clientes (roteamento por telefone — bots matriz)
 *   2. flow_clones.getCloneBySession (sessao dedicada — bots clone)
 * Pausa e isolada por fluxo — nao afeta outros bots do mesmo numero.
 */
import { logger } from '@startap/core/logger';
import { phoneHint } from '@startap/core/phone';
import { resolveSilenceGate } from '@startap/core/silence-gate';
import { antibot, clientBilling, flowClones, pausa, routing } from '@startap/db';

const log = logger.child({ job: 'antibot' });

const THRESHOLD = 6; // mensagens (>= dispara pausa)
const WINDOW_SEC = 60;

/** Opções do job. allowlistEnabled vem da env ANTIBOT_ALLOWLIST_ENABLED (default OFF). */
export interface RunAntibotOptions {
  /**
   * ALLOWLIST DURA (SCRUM-4 PR-A): quando true, NÃO pausa um suspeito que já tem histórico de
   * agendamento no clone (cliente real). Default false = comportamento de hoje, ZERO query nova.
   */
  allowlistEnabled?: boolean;
}

export async function runAntibot(
  opts: RunAntibotOptions = {},
): Promise<{ blocked: number; pruned: number; skipped: number }> {
  const allowlistEnabled = opts.allowlistEnabled === true;
  const suspects = await antibot.findSuspects(THRESHOLD, WINDOW_SEC);
  let blocked = 0;
  let skipped = 0;

  for (const s of suspects) {
    log.warn(
      { telefone: s.telefone, total: s.total, session: s.session },
      'Suspeito bot detectado',
    );

    // Etapa 1: routing_clientes (bots matriz roteados por telefone)
    const route = await routing.findRouting(s.telefone);
    let flowId: string | null = route?.workflow_id ?? null;

    // Etapa 2: fallback para clones com sessao WAHA dedicada
    if (!flowId) {
      const clone = await flowClones.getCloneBySession(s.session).catch((e: unknown) => {
        log.warn({ err: e, session: s.session }, 'antibot: erro ao buscar clone por sessao');
        return null;
      });
      // workflow_id de um clone e o seu proprio slot
      if (clone) flowId = clone.slot;
    }

    if (flowId) {
      // ── GATE ÚNICO DE SILÊNCIO TOTAL (fix pós-SCRUM-155, decisão do Bruno) ──────────────
      // Clone suspenso/vencido além da carência não deve ganhar NENHUM efeito colateral —
      // inclusive a pausa que o PRÓPRIO antibot grava. Mesma função pura do router
      // (@startap/core/silence-gate), fonte única. Flag-gated (GATE_SILENCIO_TOTAL_ENABLED,
      // default OFF): OFF = pula esta checagem, comportamento byte-idêntico ao de hoje.
      // Só clones (slot "clone_"); getCloneBySlot traz next_due_date/billing_amount_cents
      // via LEFT JOIN (getCloneBySession, usado na etapa 2 acima, NÃO traz billing).
      if (process.env.GATE_SILENCIO_TOTAL_ENABLED === 'true' && flowId.startsWith('clone_')) {
        const cloneForGate = await flowClones.getCloneBySlot(flowId).catch((e: unknown) => {
          log.warn({ err: e, slot: flowId }, 'antibot: erro ao buscar clone para gate — segue');
          return null;
        });
        if (cloneForGate) {
          const gate = resolveSilenceGate(cloneForGate, {
            graceDays: clientBilling.GRACE_DAYS,
            daysUntilDue: (nextDueDate) => clientBilling.daysUntilDue(nextDueDate),
            billingOverdueSilenceOn: process.env.BILLING_OVERDUE_SILENCE === 'true',
          });
          if (gate.silenced) {
            log.info(
              { slot: flowId, telefone: phoneHint(s.telefone), reason: gate.reason },
              'antibot: clone silenciado (gate único) — pausa NÃO gravada',
            );
            skipped++;
            continue;
          }
        }
      }

      // ── ALLOWLIST DURA (SCRUM-4 PR-A; gated por ANTIBOT_ALLOWLIST_ENABLED) ──────────────
      // Telefone que JÁ agendou neste clone = cliente real -> NÃO pausa (anti-falso-positivo).
      // Só consulta o banco com a flag ON; OFF = comportamento idêntico ao de hoje (sem query).
      // O flowId aqui é o slot do clone — escopo de tenant da checagem (ver hasScheduledHistory).
      if (allowlistEnabled) {
        const jaAgendou = await antibot
          .hasScheduledHistory(flowId, s.telefone)
          .catch((e: unknown) => {
            // Falha na checagem NÃO deve cancelar a pausa nem allowlistar por engano:
            // fail-closed (retorna false -> segue pausando, comportamento legado).
            log.warn(
              { err: e, slot: flowId, telefone: phoneHint(s.telefone) },
              'antibot: erro ao checar allowlist — fail-closed (segue pausa)',
            );
            return false;
          });
        if (jaAgendou) {
          log.info(
            { slot: flowId, telefone: phoneHint(s.telefone), total: s.total },
            'antibot: allowlist — telefone já agendou neste clone, NÃO pausando',
          );
          skipped++;
          continue;
        }
      }

      await pausa.addFlowPause({
        flowId,
        telefone: s.telefone,
        session: s.session,
        source: 'antibot',
        reason: `flood: ${s.total} msgs em ${WINDOW_SEC}s`,
      });
      blocked++;
    } else {
      log.warn(
        { session: s.session, telefone: s.telefone },
        'antibot: flow_id nao encontrado (nem em routing_clientes nem como clone) — pausa nao gravada',
      );
    }
  }

  // Limpa logs com mais de 24h
  const pruned = await antibot.pruneOldLogs(24);
  if (blocked > 0 || pruned > 0 || skipped > 0)
    log.info({ blocked, pruned, skipped }, 'Antibot pass complete');
  return { blocked, pruned, skipped };
}
