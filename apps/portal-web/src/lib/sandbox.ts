'use client';

/**
 * Cliente do "Testar conversa" (SCRUM-101) — SANDBOX da persona real do assistente.
 *
 * O DONO logado conversa com o PRÓPRIO assistente rodando a persona+tom+cartão REAIS do
 * clone, mas em SANDBOX: o backend chama o LLM com `tools: []` (nenhuma tool de escrita), então
 * NADA é agendado/pausado/gravado e NENHUMA mensagem sai por WhatsApp. É só o transporte tipado
 * + lógica pura de estado do chat (sem React/DOM — testável em node).
 *
 * Contrato (portal-api, plugin sandbox-chat.ts — autenticadas por sessão, slot SÓ da sessão via
 * withTenant; NUNCA envia slot: o cookie viaja sozinho com apiFetch credentials:'include'):
 *   GET  /portal/sandbox/status  -> { available:true, persona_configurada } | 404 (feature off)
 *   POST /portal/sandbox/chat    -> { reply, simulated } (body { messages: [{role,content}] })
 *
 * Gating: flag SANDBOX_ENABLED OFF => 404 recurso_indisponivel => a UI esconde a seção (mesmo
 * critério de lembretes/prompt-builder). Nenhuma PII é logada no client.
 */
import { ApiError, apiFetch } from './api';

const BASE = '/portal/sandbox';

/** Espelha SANDBOX_MAX_INPUT_CHARS do portal-api (content 1..1000). */
export const SANDBOX_MAX_INPUT = 1000;

export type SandboxRole = 'assistant' | 'user';

/** Uma bolha da conversa (id local incremental, texto cru do turno). */
export interface SandboxMessage {
  id: number;
  role: SandboxRole;
  text: string;
}

/** Status da feature (GET /status). `off` = flag OFF (404) => esconde a seção. */
export type SandboxStatus = { kind: 'available'; personaConfigurada: boolean } | { kind: 'off' };

/** Outcome normalizado do POST /chat (a UI reage sem conhecer HTTP). */
export type SandboxSendOutcome =
  | { kind: 'ok'; reply: string }
  | { kind: 'no_persona' }
  | { kind: 'unavailable' }
  | { kind: 'error' };

// ── Lógica pura de estado (testável, sem rede) ──────────────────────────────────

/** Anexa uma bolha ao log com id incremental estável. */
export function appendMessage(
  messages: SandboxMessage[],
  role: SandboxRole,
  text: string,
): SandboxMessage[] {
  const nextId = messages.length > 0 ? messages[messages.length - 1].id + 1 : 1;
  return [...messages, { id: nextId, role, text }];
}

/** Chars restantes até o teto de input (negativo = passou). */
export function remainingChars(input: string): number {
  return SANDBOX_MAX_INPUT - input.length;
}

/** Enviável: tem texto não-vazio, dentro do teto e sem envio em andamento. */
export function isSendable(input: string, pending: boolean): boolean {
  const t = input.trim();
  return !pending && t.length > 0 && t.length <= SANDBOX_MAX_INPUT;
}

/** Converte o log local -> payload da API (descarta o id local). */
export function toApiMessages(
  messages: SandboxMessage[],
): Array<{ role: SandboxRole; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.text }));
}

// ── Transporte ──────────────────────────────────────────────────────────────────

/** GET /status — 404 (flag OFF) vira {kind:'off'} (a seção some, sem erro). */
export async function fetchSandboxStatus(signal?: AbortSignal): Promise<SandboxStatus> {
  try {
    const res = await apiFetch<{ available: boolean; persona_configurada: boolean }>(
      `${BASE}/status`,
      { signal },
    );
    return { kind: 'available', personaConfigurada: res.persona_configurada === true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { kind: 'off' };
    throw err;
  }
}

/**
 * POST /chat — manda o log completo e devolve a resposta do assistente (simulada). Normaliza os
 * erros esperados: 409 persona_nao_configurada -> no_persona; 404/503 -> unavailable; resto -> error.
 */
export async function sendSandboxMessage(
  messages: Array<{ role: SandboxRole; content: string }>,
  signal?: AbortSignal,
): Promise<SandboxSendOutcome> {
  try {
    const res = await apiFetch<{ reply: string; simulated: boolean }>(`${BASE}/chat`, {
      method: 'POST',
      body: { messages },
      signal,
    });
    return { kind: 'ok', reply: res.reply };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) return { kind: 'no_persona' };
      if (err.status === 404 || err.status === 503) return { kind: 'unavailable' };
    }
    return { kind: 'error' };
  }
}
