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

export function bloqueioEtapaAtual(args: {
  canPickProfissional: boolean;
  profissionalSelecionado: boolean;
  repetir: boolean;
  temPrevia: boolean;
}): number {
  if (args.canPickProfissional && !args.profissionalSelecionado) return 1;
  const etapaQuando = args.canPickProfissional ? 3 : 2;
  if (!args.repetir) return etapaQuando;
  return args.temPrevia ? etapaQuando + 2 : etapaQuando + 1;
}

export function bloqueioUsaDiaInteiroPorPadrao(tipo: AgendaBloqueioTipo): boolean {
  return tipo === 'ausencia' || tipo === 'ferias';
}

export function remocaoSerieProximasDescricao(): string {
  return 'Vamos tentar remover todas as próximas ocorrências desta série da Agenda Google. Não há escolha de data inicial; se alguma falhar, ela continuará bloqueada e mostraremos a contagem. As ocorrências passadas permanecem no histórico.';
}

export function nomeGrupoAgendaBloqueio(args: {
  mode: 'owner' | 'colaborador';
  colaboradorId: number | null;
  nomeProfissional?: string;
}): string {
  if (args.colaboradorId == null) {
    return args.mode === 'colaborador' ? 'Minha agenda' : 'Agenda principal';
  }
  if (args.nomeProfissional) return args.nomeProfissional;
  return args.mode === 'colaborador' ? 'Minha agenda' : 'Profissional da equipe';
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
