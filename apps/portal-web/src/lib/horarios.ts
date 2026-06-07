/**
 * Helpers da grade horaria. Normaliza a estrutura {segunda..domingo} garantindo
 * os 7 dias (a API aceita parcial, mas a UI mostra a semana inteira) e gera as
 * opcoes de horario em passos de 30 min (spec 6.8).
 */
import { DIAS_SEMANA, type DiaSemana, type HorarioDia, type Horarios } from './api-types';

export const DIA_LABEL: Record<DiaSemana, string> = {
  segunda: 'Segunda',
  terca: 'Terça',
  quarta: 'Quarta',
  quinta: 'Quinta',
  sexta: 'Sexta',
  sabado: 'Sábado',
  domingo: 'Domingo',
};

const DEFAULT_ABRE = '09:00';
const DEFAULT_FECHA = '19:00';

/** Dia "fechado" canonico (abre/fecha nulos — exigido pelo horarioDiaSchema). */
export function diaFechado(): HorarioDia {
  return { abre: null, fecha: null, fechado: true };
}

/** Dia "aberto" com defaults seguros. */
export function diaAberto(abre = DEFAULT_ABRE, fecha = DEFAULT_FECHA): HorarioDia {
  return { abre, fecha, fechado: false };
}

/** Preenche os 7 dias a partir de uma grade parcial (dias ausentes = fechado). */
export function normalizarSemana(h: Horarios): Record<DiaSemana, HorarioDia> {
  const out = {} as Record<DiaSemana, HorarioDia>;
  for (const dia of DIAS_SEMANA) {
    const d = h[dia];
    out[dia] = d ?? diaFechado();
  }
  return out;
}

/** Opcoes "HH:MM" de 00:00 a 23:30 em passos de 30 min. */
export function timeOptions(): string[] {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += 30) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    out.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return out;
}

/** abre < fecha (em minutos). */
export function abreAntesDeFecha(abre: string, fecha: string): boolean {
  const toMin = (v: string) => {
    const [h, m] = v.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(abre) < toMin(fecha);
}
