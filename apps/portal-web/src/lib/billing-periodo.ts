/**
 * Lógica pura do PERÍODO da tela Billing (consolidação Faturamento + Comissão).
 *
 * Contexto do bug (corrigido aqui): o seletor de data antigo travava o calendário
 * em `max=hoje` nos dois inputs, e o período default era SEMPRE passado
 * (firstOfMonth → hoje). Resultado: a visão "Previsão" (eventos FUTUROS) nascia
 * vazia e o usuário NÃO conseguia escolher datas futuras — o evento de amanhã ficava
 * fora da janela. O backend (`listAtendimentos`) está correto; quem mandava a janela
 * errada era o front.
 *
 * Solução: o período (default + limites min/max + presets) passa a DEPENDER do
 * balde selecionado:
 *   - 'faturado'  -> realizado: olha o PASSADO. de=1º do mês, ate=hoje. O `ate`
 *     nunca passa de hoje (não existe faturado no futuro). de >= ... sem piso rígido
 *     (pode olhar meses atrás).
 *   - 'previsao'  -> esperado: olha o FUTURO. de=hoje, ate=hoje+30d. O `de` nunca é
 *     antes de hoje (previsão é daqui pra frente) e o picker PERMITE datas futuras.
 *
 * Tudo aqui é função pura (fuso local, sem React) pra ser testável sem jsdom —
 * convenção do portal. O componente PeriodSelector vira "burro": recebe min/max/
 * presets por prop e só renderiza.
 */
import type { AtendimentoBalde } from './api-types';
import { firstOfMonthISO, toISODate } from './format';

export interface Periodo {
  de: string; // 'YYYY-MM-DD'
  ate: string; // 'YYYY-MM-DD'
}

export interface PeriodoPreset {
  label: string;
  value: Periodo;
}

/** Limites do date-picker pra cada input (undefined = sem limite naquele lado). */
export interface PeriodoLimites {
  /** min/max do input "De". */
  de: { min?: string; max?: string };
  /** min/max do input "Até". */
  ate: { min?: string; max?: string };
}

/** Quantos dias à frente a Previsão olha por padrão. */
const PREVISAO_JANELA_DIAS = 30;

/** "YYYY-MM-DD" daqui a N dias (N pode ser negativo). Fuso local. */
function plusDaysISO(days: number, now = new Date()): string {
  return toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/**
 * Período DEFAULT pra um balde. Faturado = passado (mês corrente até hoje);
 * Previsão = futuro (hoje até hoje+30d). É o estado inicial da tela e o que cada
 * troca de aba aplica.
 */
export function periodoPadrao(balde: AtendimentoBalde, now = new Date()): Periodo {
  if (balde === 'previsao') {
    return { de: toISODate(now), ate: plusDaysISO(PREVISAO_JANELA_DIAS, now) };
  }
  return { de: firstOfMonthISO(now), ate: toISODate(now) };
}

/**
 * Limites do date-picker pra um balde. ESTE é o fix do bug: na Previsão o picker
 * PERMITE datas futuras (sem max=hoje); no Faturado o `ate` é teto em hoje.
 *   - faturado: de sem limite (passado livre), ate.max = hoje. Em ambos, de.max = ate
 *     e ate.min = de (mantém a janela coerente — de nunca passa do ate).
 *   - previsao: de.min = hoje (previsão é daqui pra frente), sem max=hoje em lado
 *     nenhum — datas futuras liberadas.
 */
export function periodoLimites(
  balde: AtendimentoBalde,
  value: Periodo,
  now = new Date(),
): PeriodoLimites {
  const hoje = toISODate(now);
  if (balde === 'previsao') {
    return {
      // de >= hoje (não previsão do passado); de <= ate (janela coerente).
      de: { min: hoje, max: value.ate || undefined },
      // ate >= de (e >= hoje); SEM teto em hoje -> futuro liberado (o fix).
      ate: { min: value.de || hoje },
    };
  }
  return {
    // de <= ate; sem piso (pode olhar meses atrás).
    de: { max: value.ate || hoje },
    // ate <= hoje (não há faturado no futuro); ate >= de.
    ate: { min: value.de || undefined, max: hoje },
  };
}

/**
 * Presets rápidos por balde. Faturado olha pra trás (Este mês / Mês passado / Hoje);
 * Previsão olha pra frente (Hoje / Próx. 7 dias / Próx. 30 dias). Calculados no fuso
 * local relativo a `now`.
 */
export function periodoPresets(balde: AtendimentoBalde, now = new Date()): PeriodoPreset[] {
  const hoje = toISODate(now);
  if (balde === 'previsao') {
    return [
      { label: 'Hoje', value: { de: hoje, ate: hoje } },
      { label: 'Próx. 7 dias', value: { de: hoje, ate: plusDaysISO(7, now) } },
      { label: 'Próx. 30 dias', value: { de: hoje, ate: plusDaysISO(30, now) } },
    ];
  }
  const inicioMes = firstOfMonthISO(now);
  const primeiroMesPassado = toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const ultimoMesPassado = toISODate(new Date(now.getFullYear(), now.getMonth(), 0));
  return [
    { label: 'Este mês', value: { de: inicioMes, ate: hoje } },
    { label: 'Mês passado', value: { de: primeiroMesPassado, ate: ultimoMesPassado } },
    { label: 'Hoje', value: { de: hoje, ate: hoje } },
  ];
}
