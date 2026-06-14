/**
 * Cliente da demo "celular" da landing (W6) — fala com a IA sandbox via
 * POST /demo/chat (proxy same-origin -> portal-api). Rota PÚBLICA (sem sessão).
 *
 * Contrato (acordado com backend/ai-engineer, ver missão 023 W6):
 *   request:  { messages: DemoChatMessage[] }   // histórico completo da conversa
 *   response: { reply: string; demo_booking?: boolean }
 *     - reply        = texto da resposta do robô (a saudação inicial é fixa no
 *                      front; o backend só responde às mensagens do usuário).
 *     - demo_booking = true quando a IA "fechou" um horário fictício -> a UI
 *                      mostra o aviso "isto é só uma demonstração".
 *   429 rate_limit  -> antiabuso (cota por IP/janela): UI vira CTA de conversão.
 *   404/503/flag OFF -> demo desligada: UI degrada (estado neutro), sem quebrar.
 *
 * Sem PII: o front NUNCA pede nome/telefone; o que trafega é só o texto digitado
 * na demo. Nada é logado no client.
 */
import { ApiError, apiFetch } from './api';

export type DemoRole = 'user' | 'assistant';

export interface DemoChatMessage {
  role: DemoRole;
  content: string;
}

export interface DemoChatResponse {
  reply: string;
  demo_booking?: boolean;
}

/** Resultado normalizado pra UI distinguir os caminhos sem vazar status cru. */
export type DemoChatOutcome =
  | { kind: 'ok'; reply: string; demoBooking: boolean }
  | { kind: 'rate_limit' }
  | { kind: 'unavailable' } // demo desligada (flag OFF / 404 / 503 / upstream fora)
  | { kind: 'error' }; // soluço transitório -> "tentar de novo"

export async function sendDemoChat(
  messages: DemoChatMessage[],
  signal?: AbortSignal,
): Promise<DemoChatOutcome> {
  try {
    const res = await apiFetch<DemoChatResponse>('/demo/chat', {
      method: 'POST',
      body: { messages },
      signal,
    });
    return {
      kind: 'ok',
      reply: typeof res.reply === 'string' ? res.reply : '',
      demoBooking: res.demo_booking === true,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 429) return { kind: 'rate_limit' };
      // Flag OFF / rota inexistente / upstream fora / indisponível = degrade.
      if (err.status === 404 || err.status === 502 || err.status === 503) {
        return { kind: 'unavailable' };
      }
    }
    // Abort de unmount não deve virar "erro" visível.
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'error' };
    }
    return { kind: 'error' };
  }
}
