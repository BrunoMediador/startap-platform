import type { AgendaBloqueioTipo } from './api-types';

export interface BloqueioTipoOption {
  value: AgendaBloqueioTipo;
  label: string;
  description: string;
}

export const BLOQUEIO_TIPO_OPTIONS: BloqueioTipoOption[] = [
  { value: 'almoco', label: 'Almoço', description: 'Pausa curta no dia' },
  { value: 'ausencia', label: 'Ausência', description: 'Compromisso ou folga' },
  { value: 'ferias', label: 'Férias', description: 'Período sem atendimentos' },
  { value: 'indisponivel', label: 'Indisponível', description: 'Outro período bloqueado' },
];

export function bloqueioEtapaAtual(args: { repetir: boolean; temPrevia: boolean }): number {
  if (!args.repetir) return 3;
  return args.temPrevia ? 4 : 3;
}

export function bloqueioResumoAcao(args: {
  repetir: boolean;
  temPrevia: boolean;
  resultado: boolean;
}): string {
  if (!args.repetir) return 'Criar bloqueio';
  if (args.resultado) return 'Concluir';
  return args.temPrevia ? 'Criar série' : 'Ver prévia';
}
