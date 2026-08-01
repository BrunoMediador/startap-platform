import { normalizePauseKeyword } from '@startap/core/pause-keyword';
import { pausa } from '@startap/db';
import { findBotByFlowId } from '../registry.js';

export type ManualPauseCommand = 'pause' | 'resume';

// Delega à normalização CANÔNICA (@startap/core) — a MESMA que o portal usa pra gravar
// keyword_norm. Uma fonte só evita frase que o dono cadastra e o bot nunca casa. Output
// byte-idêntico ao anterior (minúsculas + NFD sem acento + sem espaço).
export function normalizeManualPauseCommand(text: string): string {
  return normalizePauseKeyword(text);
}

export function getFlowManualCommand(text: string): ManualPauseCommand | null {
  const normalized = normalizeManualPauseCommand(text);
  return getDefaultFlowManualCommand(normalized);
}

export async function getFlowManualCommandForFlow(
  flowId: string,
  text: string,
): Promise<ManualPauseCommand | null> {
  const normalized = normalizeManualPauseCommand(text);
  try {
    const keywords = await pausa.listFlowPauseKeywords(flowId);
    for (const row of keywords) {
      if (!row.enabled || !row.keyword_norm) continue;
      if (normalized.includes(row.keyword_norm)) return row.command;
    }
    return null;
  } catch {
    return getDefaultFlowManualCommand(normalized);
  }
}

function getDefaultFlowManualCommand(normalized: string): ManualPauseCommand | null {
  if (
    normalized === 'startapaqui!!' ||
    normalized === 'atendenteaqui!!' ||
    normalized === 'humanoaqui!!' ||
    normalized === 'ricardoaqui!!'
  ) {
    return 'pause';
  }
  if (
    normalized === 'startapvoltar!!' ||
    normalized === 'iavoltar!!' ||
    normalized === 'botvoltar!!' ||
    normalized === 'ricardovoltar!!'
  ) {
    return 'resume';
  }
  return null;
}

export async function applyFlowManualCommand(input: {
  command: ManualPauseCommand;
  flowId: string;
  flowName?: string | null;
  telefone: string;
  session?: string | null;
  source?: string | null;
  reason?: string | null;
  /**
   * Nome do CONTATO (SCRUM-144), já resolvido pelo CALLER (router — que tem sessão e
   * telefone em mão) via store durável contact_names. Esta função NÃO resolve sozinha
   * nem faz I/O extra pra isso; só repassa. Ausente/NULL = comportamento idêntico a antes.
   */
  contactName?: string | null;
}): Promise<void> {
  if (input.command === 'pause') {
    await pausa.addFlowPause({
      flowId: input.flowId,
      flowName: input.flowName,
      telefone: input.telefone,
      session: input.session,
      source: input.source ?? 'manual',
      reason: input.reason,
      contactName: input.contactName,
    });
  } else {
    await pausa.removeFlowPause({
      flowId: input.flowId,
      telefone: input.telefone,
      session: input.session,
      source: input.source ?? 'manual',
    });
  }

  const legacyTable = findBotByFlowId(input.flowId)?.legacyPauseTable ?? null;
  if (!legacyTable) return;
  if (input.command === 'pause') await pausa.addPause(legacyTable, input.telefone);
  else await pausa.removePause(legacyTable, input.telefone);
}
