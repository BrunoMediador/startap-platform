/**
 * Job antibot — roda a cada 1 minuto.
 *
 * Substitui Monitor_AntiBot do automacao visual antiga.
 *
 * Detecta numeros enviando 6+ mensagens em 60s e grava em flow_pauses
 * (source=antibot) por fluxo. Usa routing_clientes como fonte autoritativa
 * do flow_id (telefone -> workflow_id), igual ao router de producao.
 * Pausa e isolada por fluxo — nao afeta outros bots do mesmo numero.
 */
import { logger } from '@startap/core/logger';
import { antibot, pausa, routing } from '@startap/db';

const log = logger.child({ job: 'antibot' });

const THRESHOLD = 6; // mensagens (>= dispara pausa)
const WINDOW_SEC = 60;

export async function runAntibot(): Promise<{ blocked: number; pruned: number }> {
  const suspects = await antibot.findSuspects(THRESHOLD, WINDOW_SEC);
  let blocked = 0;

  for (const s of suspects) {
    log.warn(
      { telefone: s.telefone, total: s.total, session: s.session },
      'Suspeito bot detectado',
    );

    const route = await routing.findRouting(s.telefone);
    const flowId = route?.workflow_id ?? null;

    if (flowId) {
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
        'antibot: flow_id nao encontrado para telefone em routing_clientes — pausa nao gravada',
      );
    }
  }

  // Limpa logs com mais de 24h
  const pruned = await antibot.pruneOldLogs(24);
  if (blocked > 0 || pruned > 0) log.info({ blocked, pruned }, 'Antibot pass complete');
  return { blocked, pruned };
}
