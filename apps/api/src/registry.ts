/**
 * Registry de bots — fonte única de verdade sobre quais bots existem e quais
 * sessões WAHA cada um possui.
 *
 * Antes deste módulo, router.ts importava diretamente de bots/startap.ts para
 * saber: quais sessões pertencem ao Startap, como detectar um comando manual e
 * como aplicá-lo. Qualquer novo bot com sessão própria exigiria editar o router.
 *
 * Agora cada bot chama registerBotEntry() no init. O router consulta apenas
 * findBotBySession() / findBotByFlowId() / buildFallbackRoute().
 */

import type { CloneRow, RoutingRow } from '@startap/db';
import { flowControl } from '@startap/db';
import type { Bot } from '@startap/core/types';

export type ManualCommand = 'pause' | 'resume';

export interface BotEntry {
  /** workflow_id estável — chave em routing_clientes e no botRegistry interno. */
  workflowId: string;
  /** workflow_name para logs e flow_execution_logs. */
  workflowName: string;
  /**
   * Sessões WAHA (lowercase) que pertencem a este bot.
   * Bots sem sessão própria deixam este array vazio e dependem de routing_clientes.
   * Bots com sessões próprias (ex: Startap) recebem mensagens sem registro em routing.
   */
  ownedSessions: string[];
  /**
   * Tabela de pausa legada (ex: 'pause_startap') verificada durante o roteamento
   * para bloquear mensagens recebidas enquanto humano assume a conversa.
   * Null = bot não usa tabela legada; pausa é controlada só via flow_pauses.
   */
  legacyPauseTable: string | null;
  /**
   * Detecta comando manual a partir do texto de uma mensagem fromMe.
   * Retorna null se o texto não é um comando reconhecido por este bot.
   */
  getManualCommand(text: string): ManualCommand | null;
  /**
   * Aplica o comando (pause/resume) para um telefone neste bot.
   * Responsável por atualizar flow_pauses e a tabela legada se houver.
   */
  applyManualCommand(
    command: ManualCommand,
    telefone: string,
    opts: { session?: string | null; source?: string | null },
  ): Promise<void>;
  /** Instância do bot usada pelo router para despachar mensagens. */
  bot: Bot;
}

/** Map de workflowId -> BotEntry (bots com workflowId conhecido). */
const byWorkflowId = new Map<string, BotEntry>();

/**
 * Map de sessao (lowercase) -> BotEntry.
 * Preenchido apenas para bots com ownedSessions não-vazio.
 */
const bySession = new Map<string, BotEntry>();

export function registerBotEntry(entry: BotEntry): void {
  byWorkflowId.set(entry.workflowId, entry);
  for (const s of entry.ownedSessions) {
    bySession.set(s.toLowerCase(), entry);
  }
}

/** Retorna o BotEntry cujo workflowId ou ownedSessions contém esta sessão. */
export function findBotBySession(sessao: string): BotEntry | null {
  return bySession.get(sessao.toLowerCase()) ?? null;
}

export function findBotByFlowId(workflowId: string): BotEntry | null {
  return byWorkflowId.get(workflowId) ?? null;
}

export function getAllEntries(): BotEntry[] {
  return Array.from(byWorkflowId.values());
}

/**
 * Constrói uma RoutingRow sintética para bots que possuem sessões próprias e
 * não necessitam de registro em routing_clientes.
 *
 * Retorna null se o flow_control do bot estiver inativo.
 */
export async function buildFallbackRoute(
  entry: BotEntry,
  telefone: string,
): Promise<RoutingRow | null> {
  const active = await flowControl.isFlowActive(entry.workflowId);
  if (!active) return null;
  return {
    id: 0,
    telefone,
    workflow_id: entry.workflowId,
    workflow_name: entry.workflowName,
    webhook_url: null,
    nome_cliente: null,
    ativo: true,
    criado_em: new Date(),
    atualizado_em: new Date(),
  };
}

/**
 * Constrói uma RoutingRow sintética para um clone, roteado pela sessão WAHA dedicada.
 * Retorna null se o flow_control do clone estiver inativo.
 */
export async function buildCloneRoute(
  clone: CloneRow,
  telefone: string,
): Promise<RoutingRow | null> {
  const active = await flowControl.isFlowActive(clone.slot);
  if (!active) return null;
  return {
    id: 0,
    telefone,
    workflow_id: clone.slot,
    workflow_name: clone.display_name,
    webhook_url: null,
    nome_cliente: clone.cliente_nome,
    ativo: true,
    criado_em: new Date(),
    atualizado_em: new Date(),
  };
}
