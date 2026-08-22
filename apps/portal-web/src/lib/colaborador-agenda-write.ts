import type { ColaboradorAgendaResponse } from './api-types';

/**
 * A escrita na agenda pessoal só aparece com permissão explícita do servidor.
 * Ausência preserva o painel antigo como leitura durante rollout, falha de
 * contrato ou quando a empresa desligar a capability.
 */
export function podeGerenciarAgendaColaborador(
  agenda: Pick<ColaboradorAgendaResponse, 'agenda_write_enabled'>,
): boolean {
  return agenda.agenda_write_enabled === true;
}
