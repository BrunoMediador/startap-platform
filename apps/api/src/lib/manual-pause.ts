import { pausa } from '@startap/db';

export type ManualPauseCommand = 'pause' | 'resume';

const LEGACY_PAUSE_BY_FLOW: Record<string, string> = {
  '0ni38aSspWwhooHd': 'pausa_cirilo',
  dlpKXM3gvX2joC1b: 'pause_ricardo',
  uUS3Ux1cU2DquKxo: 'pause_startap',
};

export function normalizeManualPauseCommand(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, '');
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
}): Promise<void> {
  if (input.command === 'pause') {
    await pausa.addFlowPause({
      flowId: input.flowId,
      flowName: input.flowName,
      telefone: input.telefone,
      session: input.session,
      source: input.source ?? 'manual',
      reason: input.reason,
    });
  } else {
    await pausa.removeFlowPause({
      flowId: input.flowId,
      telefone: input.telefone,
      session: input.session,
      source: input.source ?? 'manual',
    });
  }

  const legacyTable = LEGACY_PAUSE_BY_FLOW[input.flowId];
  if (!legacyTable) return;
  if (input.command === 'pause') await pausa.addPause(legacyTable, input.telefone);
  else await pausa.removePause(legacyTable, input.telefone);
}
