/**
 * Logica pura do card de PAUSAR/RETOMAR o atendimento (eixo flow_enabled), SEPARADA
 * da maquina de reconexao WAHA. Toda a decisao de qual estado mostrar vive aqui pra
 * ser testavel sem DOM (mesma convencao dos outros lib/*.ts deste projeto).
 *
 * GATING: a feature inteira e gated por PORTAL_BOT_PAUSE no backend. Quando a flag
 * esta OFF, o GET /portal/conexao NAO devolve bot_paused/pause_self/pause_locked
 * (campos undefined) — `isPausaFeatureOff` detecta isso e o card some (degrada limpo).
 *
 * Contrato (BE e FE iguais):
 *   bot_paused   = flow_enabled === false
 *   pause_self   = bot_paused && suspended_kind === 'owner_request'  (o cliente pausou)
 *   pause_locked = bot_paused && !pause_self                          (pausa da Startap)
 */
import type { ConexaoResponse } from './api-types';

/** Os 3 estados visiveis do card (alem do "feature off", que esconde tudo). */
export type PausaEstado =
  | 'ativo' // atendimento ligado -> botao "Pausar"
  | 'pausado_self' // o cliente pausou -> botao "Retomar"
  | 'pausado_startap'; // suspenso pela Startap -> toggle travado + suporte

/**
 * Subconjunto do GET /portal/conexao que importa pra pausa. Os 3 sao opcionais
 * porque vem AUSENTES com a flag PORTAL_BOT_PAUSE OFF.
 */
export interface PausaSnapshot {
  bot_paused?: boolean;
  pause_self?: boolean;
  pause_locked?: boolean;
}

/**
 * Feature OFF = o backend NAO expos os campos de pausa (flag PORTAL_BOT_PAUSE off).
 * Detecta pela AUSENCIA de `bot_paused` (undefined). Com a flag ON o backend SEMPRE
 * manda bot_paused (boolean), mesmo que false. Nesse caso o card aparece.
 */
export function isPausaFeatureOff(data: PausaSnapshot): boolean {
  return typeof data.bot_paused !== 'boolean';
}

/**
 * Resolve o estado visivel do card a partir do snapshot. So faz sentido chamar
 * quando a feature esta ON (`!isPausaFeatureOff`). `pause_locked` tem prioridade:
 * uma pausa da Startap NUNCA pode virar "retomar" pro cliente (so o suporte tira).
 */
export function resolvePausaEstado(data: PausaSnapshot): PausaEstado {
  if (!data.bot_paused) return 'ativo';
  if (data.pause_locked) return 'pausado_startap';
  if (data.pause_self) return 'pausado_self';
  // Pausado mas sem self nem locked: trata como travado pela Startap (conservador —
  // nao oferece "retomar" num estado ambiguo que o cliente nao controla).
  return 'pausado_startap';
}

/** O toggle reflete "atendimento ligado?" — ON quando NAO esta pausado. */
export function isAtendimentoLigado(estado: PausaEstado): boolean {
  return estado === 'ativo';
}

/** Pausa da Startap = toggle TRAVADO (o cliente nao pode mexer). */
export function isPausaTravada(estado: PausaEstado): boolean {
  return estado === 'pausado_startap';
}

/** Mensagem amigavel do 409 'suspensao_startap' no resume (sem expor motivo cru). */
export const MSG_SUSPENSAO_STARTAP =
  'Seu atendimento foi pausado pela Startap. Fale com o suporte.';

/**
 * Aplica os campos de pausa sobre uma ConexaoResponse cacheada (update otimista
 * apos pause/resume). Mantem o resto do objeto intacto. `paused=true` => pausa do
 * proprio cliente (pause_self); `paused=false` => atendimento ligado.
 */
export function applyPausaToConexao(prev: ConexaoResponse, paused: boolean): ConexaoResponse {
  return {
    ...prev,
    bot_paused: paused,
    pause_self: paused,
    pause_locked: false,
  };
}
